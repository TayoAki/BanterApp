import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './db-setup.js';
import { createHarness, type TestHarness, USER_A, USER_B } from './helpers.js';

let h: TestHarness;
beforeAll(async () => {
  h = await createHarness();
  for (const u of [USER_A, USER_B]) {
    await h.ctx.sql`insert into auth.users (id) values (${u}) on conflict do nothing`;
    await h.ctx.sql`insert into public.profiles (id) values (${u}) on conflict do nothing`;
  }
  await h.ctx.sql`insert into public.daily_assignments (user_id, local_date, timezone_snapshot, framework_id, framework_version, prompt_id, prompt_version, reason)
    values (${USER_A}, current_date, 'UTC', 'F02', '1.0', 'F02-P01', 1, 'next_unit'), (${USER_B}, current_date, 'UTC', 'F01', '1.0', 'F01-P01', 1, 'next_unit')`;
  await h.ctx.sql`insert into public.jobs (user_id, type, generation, stage_key, state) values (${USER_A}, 'cleanup_assets', 0, 'rls:1', 'queued')`;
});
afterAll(async () => h.close());

/** Runs a query as a Supabase client role with request.jwt.claims set, like PostgREST does. */
async function asRole<T extends postgres.Row[]>(role: 'anon' | 'authenticated', sub: string | null, query: string): Promise<T> {
  const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx.unsafe(`select set_config('request.jwt.claims', '${JSON.stringify(sub ? { sub, role } : { role })}', true)`);
      return await tx.unsafe(query);
    });
    return rows as unknown as T;
  } finally {
    await sql.end();
  }
}

describe('row level security', () => {
  it('a user reads only their own assignments and profile', async () => {
    const mine = await asRole<{ user_id: string }[]>('authenticated', USER_A, 'select user_id from public.daily_assignments');
    expect(mine.map((r) => r.user_id)).toEqual([USER_A]);
    const profiles = await asRole<{ id: string }[]>('authenticated', USER_A, 'select id from public.profiles');
    expect(profiles.map((r) => r.id)).toEqual([USER_A]);
    const theirs = await asRole<{ user_id: string }[]>('authenticated', USER_B, 'select user_id from public.daily_assignments');
    expect(theirs.map((r) => r.user_id)).toEqual([USER_B]);
  });

  it('anonymous users see published content only and nothing private', async () => {
    const drafts = await asRole<{ n: number }[]>('anon', null, "select count(*)::int as n from public.prompt_versions where publication_status <> 'published'");
    expect(drafts[0]!.n).toBe(0);
    const published = await asRole<{ n: number }[]>('anon', null, 'select count(*)::int as n from public.prompt_versions');
    expect(published[0]!.n).toBeGreaterThan(0); // development manifest publishes drafts for local runs
    await expect(asRole('anon', null, 'select * from public.daily_assignments')).rejects.toThrow(/permission denied/);
  });

  it('clients have no access to jobs, audio assets, reservations or billing tables, and cannot write', async () => {
    for (const table of ['jobs', 'audio_assets', 'reservations', 'billing_events', 'reports', 'deletion_jobs', 'telemetry_events']) {
      await expect(asRole('authenticated', USER_A, `select * from public.${table}`)).rejects.toThrow(/permission denied/);
    }
    await expect(asRole('authenticated', USER_A, `update public.profiles set role = 'editor' where id = '${USER_A}'`)).rejects.toThrow(/permission denied/);
    await expect(asRole('authenticated', USER_A, `insert into public.completions (user_id, lesson_id, lesson_version, attempt_id, local_day, xp) values ('${USER_A}', 'x', 1, gen_random_uuid(), current_date, 999)`)).rejects.toThrow(/permission denied/);
    await expect(asRole('authenticated', USER_A, `select public.reserve_session_allowance('${USER_A}', gen_random_uuid(), current_date, 99, interval '1 hour')`)).rejects.toThrow(/permission denied/);
  });

  it('a user cannot reference another user’s session from their own attempt (composite ownership FK)', async () => {
    const s = await h.ctx.sql<{ id: string }[]>`
      insert into public.practice_sessions (user_id, mode, framework_id, framework_version, prompt_id, prompt_version, quota_window_date, client_key)
      values (${USER_B}, 'daily', 'F02', '1.0', 'F02-P01', 1, current_date, 'rls-session-key-0123456789abcdef') returning id`;
    await expect(
      h.ctx.sql`insert into public.attempts (user_id, session_id, ordinal, input_mode, client_key) values (${USER_A}, ${s[0]!.id}, 1, 'voice', 'rls-attempt-key-0123456789abcdef')`,
    ).rejects.toThrow(/foreign key/);
  });
});
