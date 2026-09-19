import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueJob, type JobRow } from '../domain/jobs.js';
import { createHarness, type TestHarness, USER_A } from './helpers.js';

let h: TestHarness;
beforeAll(async () => {
  h = await createHarness();
  await h.ctx.sql`insert into auth.users (id) values (${USER_A}) on conflict do nothing`;
  await h.ctx.sql`insert into public.profiles (id) values (${USER_A}) on conflict do nothing`;
});
afterAll(async () => h.close());

const claim = (worker: string, lease = '2 minutes', limit = 5) => h.ctx.sql<JobRow[]>`select * from public.claim_jobs(${worker}, ${lease}::interval, ${limit})`;

describe('durable job queue', () => {
  it('enqueues once per stage key and two workers never claim the same job', async () => {
    for (let i = 0; i < 6; i += 1) {
      await enqueueJob(h.ctx.sql, { userId: USER_A, type: 'cleanup_assets', generation: 0, stageKey: `t1:${i}` });
    }
    const dup = await enqueueJob(h.ctx.sql, { userId: USER_A, type: 'cleanup_assets', generation: 0, stageKey: 't1:0' });
    expect(dup.created).toBe(false);
    const [a, b] = await Promise.all([claim('w1', '2 minutes', 4), claim('w2', '2 minutes', 4)]);
    const ids = new Set([...a, ...b].map((j) => j.id));
    expect(ids.size).toBe(a.length + b.length);
    expect(a.length + b.length).toBe(6);
    expect([...a, ...b].every((j) => j.state === 'running' && j.attempts === 1)).toBe(true);
  });

  it('reclaims a job whose lease expired and refuses commit from the previous worker', async () => {
    const { job } = await enqueueJob(h.ctx.sql, { userId: USER_A, type: 'cleanup_assets', generation: 0, stageKey: 't2:lease' });
    const first = await claim('w-crash', '1 millisecond');
    expect(first.some((j) => j.id === job.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    const second = await claim('w-alive', '2 minutes');
    const reclaimed = second.find((j) => j.id === job.id);
    expect(reclaimed?.worker_id).toBe('w-alive');
    expect(reclaimed?.attempts).toBe(2);
    const stale = await h.ctx.sql<{ complete_job: boolean }[]>`select public.complete_job(${job.id}, 'w-crash', null, null, '{}'::jsonb)`;
    expect(stale[0]!.complete_job).toBe(false);
    const ok = await h.ctx.sql<{ complete_job: boolean }[]>`select public.complete_job(${job.id}, 'w-alive', null, null, '{"done":true}'::jsonb)`;
    expect(ok[0]!.complete_job).toBe(true);
  });

  it('requeues a retryable failure with backoff, then fails terminally after max attempts', async () => {
    const { job } = await enqueueJob(h.ctx.sql, { userId: USER_A, type: 'cleanup_assets', generation: 0, stageKey: 't3:retry', maxAttempts: 2 });
    let claimed = (await claim('w3')).find((j) => j.id === job.id)!;
    const r1 = await h.ctx.sql<{ fail_job: string }[]>`select public.fail_job(${claimed.id}, 'w3', 'provider_transient', 'boom', true, interval '0 seconds', '{}'::jsonb)`;
    expect(r1[0]!.fail_job).toBe('requeued');
    claimed = (await claim('w3')).find((j) => j.id === job.id)!;
    expect(claimed.attempts).toBe(2);
    const r2 = await h.ctx.sql<{ fail_job: string }[]>`select public.fail_job(${claimed.id}, 'w3', 'provider_transient', 'boom', true, interval '0 seconds', '{}'::jsonb)`;
    expect(r2[0]!.fail_job).toBe('failed');
    const row = (await h.ctx.sql<JobRow[]>`select * from public.jobs where id = ${job.id}`)[0]!;
    expect(row.state).toBe('failed');
    // Resuming the same logical stage requeues it (bounded) instead of creating new work.
    const resumed = await enqueueJob(h.ctx.sql, { userId: USER_A, type: 'cleanup_assets', generation: 0, stageKey: 't3:retry', maxAttempts: 2 });
    expect(resumed.created).toBe(true);
    expect(resumed.job.state).toBe('queued');
    expect(resumed.job.attempts).toBe(0);
  });

  it('does not retry a non-retryable failure', async () => {
    const { job } = await enqueueJob(h.ctx.sql, { userId: USER_A, type: 'cleanup_assets', generation: 0, stageKey: 't4:bad' });
    const claimed = (await claim('w4')).find((j) => j.id === job.id)!;
    const r = await h.ctx.sql<{ fail_job: string }[]>`select public.fail_job(${claimed.id}, 'w4', 'invalid_model_output', 'bad', false, interval '0 seconds', '{}'::jsonb)`;
    expect(r[0]!.fail_job).toBe('failed');
  });

  it('sweeps exhausted leases to failed and cancels an attempt’s remaining jobs', async () => {
    await h.ctx.sql`insert into public.jobs (user_id, type, generation, stage_key, state, lease_until, attempts, max_attempts, worker_id)
      values (${USER_A}, 'cleanup_assets', 0, 't5:exhausted', 'running', now() - interval '1 minute', 2, 2, 'w-dead')`;
    expect((await h.ctx.sql<{ n: number }[]>`select public.sweep_exhausted_jobs() as n`)[0]!.n).toBe(1);
    const attemptId = '33333333-3333-4333-8333-333333333333';
    await h.ctx.sql`insert into public.jobs (user_id, attempt_id, type, generation, stage_key, state) values (${USER_A}, ${attemptId}, 'evaluate', 0, 't5:a', 'queued'), (${USER_A}, ${attemptId}, 'rewrite', 0, 't5:b', 'running')`;
    expect((await h.ctx.sql<{ n: number }[]>`select public.cancel_jobs_for_attempt(${attemptId}, 'deleted') as n`)[0]!.n).toBe(2);
  });
});

describe('lease and checkpoint hardening', () => {
  it('does not re-run a job whose lease expired after its attempts were exhausted', async () => {
    await h.ctx.sql`insert into public.jobs (user_id, type, generation, stage_key, state, lease_until, attempts, max_attempts, worker_id)
      values (${USER_A}, 'cleanup_assets', 0, 't6:exhausted', 'running', now() - interval '1 minute', 2, 2, 'w-dead')`;
    const claimed = await claim('w6');
    expect(claimed.some((j) => j.stage_key === 't6:exhausted')).toBe(false);
  });

  it('merges checkpoints on failure instead of overwriting them', async () => {
    const { job } = await enqueueJob(h.ctx.sql, { userId: USER_A, type: 'cleanup_assets', generation: 0, stageKey: 't7:ckpt', maxAttempts: 3 });
    const claimed = (await claim('w7')).find((j) => j.id === job.id)!;
    await h.ctx.sql`update public.jobs set checkpoint = checkpoint || '{"transcript":"kept"}'::jsonb where id = ${claimed.id}`;
    await h.ctx.sql`select public.fail_job(${claimed.id}, 'w7', 'provider_transient', 'x', true, interval '0 seconds', '{"billing_uncertain":true}'::jsonb)`;
    const row = (await h.ctx.sql<JobRow[]>`select * from public.jobs where id = ${job.id}`)[0]!;
    expect(row.checkpoint).toMatchObject({ transcript: 'kept', billing_uncertain: true });
  });
});
