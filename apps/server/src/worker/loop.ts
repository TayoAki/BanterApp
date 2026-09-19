import type { ServerContext } from '../context.js';
import { releaseSession } from '../domain/allowance.js';
import type { JobRow } from '../domain/jobs.js';
import {
  handleDeleteAccount,
  handleDeleteAttempt,
  handleEvaluate,
  handleReconcileEntitlement,
  handleRewrite,
  handleRoleplayEvaluate,
  handleRoleplayTurn,
  handleSpeech,
  handleTranscribe,
  StaleJobError,
  type StageOutcome,
} from './handlers.js';
import { backoffFor } from './pipeline.js';

type Handler = (ctx: ServerContext, job: JobRow) => Promise<StageOutcome>;

const HANDLERS: Record<JobRow['type'], Handler> = {
  transcribe: handleTranscribe,
  evaluate: handleEvaluate,
  rewrite: handleRewrite,
  speech: handleSpeech,
  roleplay_turn: handleRoleplayTurn,
  roleplay_evaluate: handleRoleplayEvaluate,
  cleanup_assets: async (ctx, job) => {
    await cleanupExpiredAssets(ctx);
    await ctx.sql`update public.jobs set state = 'succeeded', finished_at = now(), updated_at = now(), lease_until = null where id = ${job.id}`;
    return { resultId: null, resultKind: null };
  },
  delete_attempt: handleDeleteAttempt,
  delete_account: handleDeleteAccount,
  reconcile_entitlement: handleReconcileEntitlement,
};

/**
 * Durable worker: claims ready jobs with FOR UPDATE SKIP LOCKED, renews its
 * lease while working, and records success/failure through the SQL
 * functions so a crashed worker's job is reclaimed after lease expiry.
 */
export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly ctx: ServerContext) {}

  /** Processes up to `limit` ready jobs once. Tests drive the worker with this. */
  async runOnce(limit = 5): Promise<number> {
    const lease = `${this.ctx.config.WORKER_LEASE_SECONDS} seconds`;
    const jobs = await this.ctx.sql<JobRow[]>`select * from public.claim_jobs(${this.ctx.config.workerId}, ${lease}::interval, ${limit})`;
    for (const job of jobs) await this.process(job);
    return jobs.length;
  }

  /** Drains the queue until no ready jobs remain (bounded), for tests. */
  async drain(maxRounds = 20): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i += 1) {
      const n = await this.runOnce(10);
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  async process(job: JobRow): Promise<void> {
    const { ctx } = this;
    const log = ctx.log.child({ job_id: job.id, type: job.type, attempt: job.attempts });
    const leaseMs = ctx.config.WORKER_LEASE_SECONDS * 1000;
    const renew = setInterval(() => {
      ctx.sql`select public.renew_job_lease(${job.id}, ${ctx.config.workerId}, ${`${ctx.config.WORKER_LEASE_SECONDS} seconds`}::interval)`.catch((err: unknown) =>
        log.warn({ err: String(err) }, 'lease renewal failed'),
      );
    }, Math.max(leaseMs / 3, 1000));
    const started = Date.now();
    try {
      const handler = HANDLERS[job.type];
      const outcome = await handler({ ...ctx, config: { ...ctx.config } }, { ...job, worker_id: ctx.config.workerId });
      log.info({ ms: Date.now() - started, result_kind: outcome.resultKind }, 'job succeeded');
    } catch (err) {
      if (err instanceof StaleJobError) {
        await ctx.sql`update public.jobs set state = 'canceled', error_code = 'stale', error_message = ${err.message}, finished_at = now(), updated_at = now(), lease_until = null
           where id = ${job.id} and worker_id = ${ctx.config.workerId} and state = 'running'`;
        log.info({ reason: err.message }, 'job discarded as stale');
        return;
      }
      const b = backoffFor(err, job.attempts);
      const result = await ctx.sql<{ fail_job: string }[]>`
        select public.fail_job(${job.id}, ${ctx.config.workerId}, ${b.code}, ${b.message.slice(0, 500)}, ${b.retryable}, ${`${Math.round(b.delayMs / 1000)} seconds`}::interval,
          ${ctx.sql.json({ billing_uncertain: b.billingUncertain } as never)})`;
      const state = result[0]?.fail_job ?? 'unknown';
      log.warn({ code: b.code, retryable: b.retryable, state, billing_uncertain: b.billingUncertain, ms: Date.now() - started }, 'job failed');
      if (state === 'failed') await this.onTerminalFailure(job, b.code, b.message, b.retryable);
    } finally {
      clearInterval(renew);
    }
  }

  /** Surface a recoverable error to the learner and release unused allowance for initial-stage system failures. */
  private async onTerminalFailure(job: JobRow, code: string, message: string, retryable: boolean): Promise<void> {
    const { ctx } = this;
    const safe = code === 'invalid_model_output' ? 'Feedback couldn’t finish yet.' : 'The service couldn’t finish this step.';
    switch (job.type) {
      case 'transcribe':
        await ctx.sql`update public.attempts set stage = 'uploaded', recoverable_error = ${ctx.sql.json({ code, message: safe, retryable: true, stage: 'transcribe' } as never)}, updated_at = now()
           where id = ${job.attempt_id} and deleted_at is null and stage = 'transcribing'`;
        if (job.session_id) await this.releaseIfInitial(job);
        break;
      case 'evaluate':
        await ctx.sql`update public.attempts set stage = 'transcript_review', recoverable_error = ${ctx.sql.json({ code, message: safe, retryable: true, stage: 'evaluate' } as never)}, updated_at = now()
           where id = ${job.attempt_id} and deleted_at is null and stage = 'evaluating'`;
        if (job.session_id) await this.releaseIfInitial(job);
        break;
      case 'rewrite': {
        const rewriteId = String(job.payload['rewrite_id']);
        await ctx.sql`update public.rewrites set status = 'unavailable', error = ${ctx.sql.json({ code, message: safe } as never)}, updated_at = now()
           where id = ${rewriteId} and status in ('queued', 'generating', 'validating')`;
        break;
      }
      case 'speech':
      case 'roleplay_turn':
      case 'roleplay_evaluate':
      case 'cleanup_assets':
      case 'reconcile_entitlement':
        break;
      case 'delete_attempt':
      case 'delete_account':
        await ctx.sql`update public.deletion_jobs set state = 'failed', last_error = ${message.slice(0, 300)}, retry_count = retry_count + 1
           where user_id = ${job.user_id} and state <> 'completed' and ${job.type === 'delete_attempt' ? ctx.sql`attempt_id = ${job.attempt_id}` : ctx.sql`scope = 'account'`}`;
        break;
    }
    void retryable;
  }

  private async releaseIfInitial(job: JobRow): Promise<void> {
    const { ctx } = this;
    const attempt = (await ctx.sql<{ is_guided_retry: boolean; session_id: string }[]>`select is_guided_retry, session_id from public.attempts where id = ${job.attempt_id}`)[0];
    if (!attempt || attempt.is_guided_retry) return;
    const committed = await ctx.sql<{ status: string }[]>`select status from public.reservations where session_id = ${attempt.session_id}`;
    if (committed[0]?.status === 'reserved') {
      await releaseSession(ctx.sql, attempt.session_id);
      await ctx.sql`update public.practice_sessions set status = 'released', updated_at = now() where id = ${attempt.session_id} and status = 'active'`;
    }
  }

  /** Periodic maintenance: expired reservations, exhausted leases, expired media objects. */
  async sweep(): Promise<{ released: number; exhausted: number; cleaned: number }> {
    const { ctx } = this;
    const released = (await ctx.sql<{ n: number }[]>`select public.release_expired_reservations(100) as n`)[0]?.n ?? 0;
    const exhausted = (await ctx.sql<{ n: number }[]>`select public.sweep_exhausted_jobs() as n`)[0]?.n ?? 0;
    const cleaned = await cleanupExpiredAssets(ctx);
    return { released, exhausted, cleaned };
  }

  start(): void {
    const tick = async () => {
      if (this.stopping) return;
      try {
        const n = await this.runOnce(5);
        if (Math.random() < 0.05) await this.sweep();
        this.timer = setTimeout(tick, n > 0 ? 50 : this.ctx.config.WORKER_POLL_MS);
      } catch (err) {
        this.ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, 'worker tick failed');
        this.timer = setTimeout(tick, this.ctx.config.WORKER_POLL_MS * 5);
      }
    };
    this.inFlight = tick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }
}

/**
 * Removes expired or deleted raw/TTS objects from storage and marks them. A
 * missing object is treated as removed. Returns the count of objects removed.
 */
export async function cleanupExpiredAssets(ctx: ServerContext, limit = 200): Promise<number> {
  const rows = await ctx.sql<{ id: string; object_key: string; state: string }[]>`
    select id, object_key, state from public.audio_assets
     where storage_deleted_at is null and (deleted_at is not null or (expires_at is not null and expires_at < now()))
     order by coalesce(deleted_at, expires_at) limit ${limit}`;
  if (rows.length === 0) return 0;
  await ctx.storage.remove(rows.map((r) => r.object_key));
  await ctx.sql`
    update public.audio_assets set storage_deleted_at = now(), state = case when deleted_at is not null then 'deleted' else 'expired' end, updated_at = now()
     where id in ${ctx.sql(rows.map((r) => r.id))}`;
  return rows.length;
}
