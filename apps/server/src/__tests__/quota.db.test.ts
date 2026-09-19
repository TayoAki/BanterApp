import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type TestHarness, USER_A } from './helpers.js';

let h: TestHarness;
beforeAll(async () => {
  h = await createHarness({ FREE_SESSIONS_PER_UTC_DAY: '1', PRO_SESSIONS_PER_UTC_DAY: '3' });
  await h.ctx.sql`insert into auth.users (id) values (${USER_A}) on conflict do nothing`;
  await h.ctx.sql`insert into public.profiles (id) values (${USER_A}) on conflict do nothing`;
});
afterAll(async () => h.close());

async function newSession(user: string) {
  const rows = await h.ctx.sql<{ id: string }[]>`
    insert into public.practice_sessions (user_id, mode, framework_id, framework_version, prompt_id, prompt_version, quota_window_date, client_key)
    values (${user}, 'daily', 'F02', '1.0', 'F02-P01', 1, current_date, ${`k-${Math.random().toString(36).slice(2)}-0123456789abcdef`}) returning id`;
  return rows[0]!.id;
}

const reserve = (session: string, allowed: number) =>
  h.ctx.sql<{ reservation_id: string; allowed: number; reserved: number; committed: number }[]>`
    select * from public.reserve_session_allowance(${USER_A}, ${session}, current_date, ${allowed}, interval '2 hours')`;

describe('allowance reservation', () => {
  it('two simultaneous starts near the cap admit exactly one', async () => {
    const s1 = await newSession(USER_A);
    const s2 = await newSession(USER_A);
    const results = await Promise.allSettled([reserve(s1, 1), reserve(s2, 1)]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(String(failed[0]!.reason)).toMatch(/quota_exceeded/);
    const w = (await h.ctx.sql<{ reserved: number; committed: number; allowed_sessions: number }[]>`select * from public.quota_windows where user_id = ${USER_A} and window_date = current_date`)[0]!;
    expect(w.reserved + w.committed).toBe(1);
  });

  it('is idempotent for the same session and commits once', async () => {
    const reservedSession = (await h.ctx.sql<{ session_id: string }[]>`select session_id from public.reservations where status = 'reserved' limit 1`)[0]!.session_id;
    const again = await reserve(reservedSession, 1);
    expect(again[0]!.reserved).toBe(1);
    expect(await h.ctx.sql`select public.commit_session_allowance(${reservedSession})`).toBeTruthy();
    await h.ctx.sql`select public.commit_session_allowance(${reservedSession})`;
    const w = (await h.ctx.sql<{ reserved: number; committed: number }[]>`select * from public.quota_windows where user_id = ${USER_A} and window_date = current_date`)[0]!;
    expect(w).toMatchObject({ reserved: 0, committed: 1 });
  });

  it('granting Pro mid-window raises the cap without resetting usage; release returns capacity', async () => {
    const s3 = await newSession(USER_A);
    const r = await reserve(s3, 3);
    expect(r[0]).toMatchObject({ allowed: 3, reserved: 1, committed: 1 });
    expect((await h.ctx.sql<{ release_session_allowance: boolean }[]>`select public.release_session_allowance(${s3})`)[0]!.release_session_allowance).toBe(true);
    const w = (await h.ctx.sql<{ reserved: number; committed: number; allowed_sessions: number }[]>`select * from public.quota_windows where user_id = ${USER_A} and window_date = current_date`)[0]!;
    expect(w).toMatchObject({ reserved: 0, committed: 1, allowed_sessions: 3 });
    // A released reservation can be re-taken when the learner resumes the same session.
    const back = await reserve(s3, 3);
    expect(back[0]!.reserved).toBe(1);
  });

  it('expired reservations are released only when no job is queued or running for the session', async () => {
    const s4 = await newSession(USER_A);
    await h.ctx.sql`insert into public.quota_windows (user_id, window_date, allowed_sessions) values (${USER_A}, current_date, 3) on conflict (user_id, window_date) do update set allowed_sessions = greatest(public.quota_windows.allowed_sessions, 3)`;
    await h.ctx.sql`insert into public.reservations (user_id, window_date, session_id, status, expires_at) values (${USER_A}, current_date, ${s4}, 'reserved', now() - interval '1 minute')`;
    await h.ctx.sql`update public.quota_windows set reserved = reserved + 1 where user_id = ${USER_A} and window_date = current_date`;
    await h.ctx.sql`insert into public.jobs (user_id, session_id, type, generation, stage_key, state) values (${USER_A}, ${s4}, 'evaluate', 0, ${`guard:${s4}`}, 'running')`;
    expect((await h.ctx.sql<{ n: number }[]>`select public.release_expired_reservations(10) as n`)[0]!.n).toBe(0);
    await h.ctx.sql`update public.jobs set state = 'failed' where stage_key = ${`guard:${s4}`}`;
    expect((await h.ctx.sql<{ n: number }[]>`select public.release_expired_reservations(10) as n`)[0]!.n).toBe(1);
    expect((await h.ctx.sql<{ status: string }[]>`select status from public.practice_sessions where id = ${s4}`)[0]!.status).toBe('expired');
  });

  it('never lets reserved + committed exceed the cap (CHECK constraint)', async () => {
    await expect(h.ctx.sql`update public.quota_windows set committed = 99 where user_id = ${USER_A} and window_date = current_date`).rejects.toThrow();
  });
});
