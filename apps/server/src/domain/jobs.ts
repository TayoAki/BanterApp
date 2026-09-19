import type { JobStatusDto, JobType } from '@marshmemos/contracts';
import type { ServerContext } from '../context.js';
import type { Db } from '../db/client.js';
import { ApiError } from '../http/errors.js';

export interface JobRow {
  id: string;
  user_id: string;
  attempt_id: string | null;
  session_id: string | null;
  type: JobType;
  transcript_revision: number | null;
  generation: number;
  stage_key: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  scheduled_at: Date;
  lease_until: Date | null;
  worker_id: string | null;
  attempts: number;
  max_attempts: number;
  checkpoint: Record<string, unknown>;
  payload: Record<string, unknown>;
  result_id: string | null;
  result_kind: string | null;
  error_code: string | null;
  error_message: string | null;
  error_retryable: boolean | null;
  updated_at: Date;
}

export const MAX_REQUEUES = 3;

/**
 * Enqueue exactly once per stage key. Returns the existing job when the key
 * already exists (idempotent resume of the same logical stage).
 */
export async function enqueueJob(
  sql: Db,
  input: {
    userId: string;
    attemptId?: string | null;
    sessionId?: string | null;
    type: JobType;
    transcriptRevision?: number | null;
    generation: number;
    stageKey: string;
    payload?: Record<string, unknown>;
    maxAttempts?: number;
    scheduledAt?: Date;
  },
): Promise<{ job: JobRow; created: boolean }> {
  const inserted = await sql<JobRow[]>`
    insert into public.jobs (user_id, attempt_id, session_id, type, transcript_revision, generation, stage_key, state, payload, max_attempts, scheduled_at)
    values (${input.userId}, ${input.attemptId ?? null}, ${input.sessionId ?? null}, ${input.type}, ${input.transcriptRevision ?? null},
      ${input.generation}, ${input.stageKey}, 'queued', ${sql.json((input.payload ?? {}) as never)}, ${input.maxAttempts ?? 2}, ${input.scheduledAt ?? new Date()})
    on conflict (stage_key) do nothing
    returning *`;
  if (inserted[0]) return { job: inserted[0], created: true };
  const existing = await sql<JobRow[]>`select * from public.jobs where stage_key = ${input.stageKey}`;
  if (!existing[0]) throw new Error('job vanished after conflict');
  if (existing[0].state === 'failed' || existing[0].state === 'canceled') {
    // Resuming the same failed logical stage: bounded requeue keeps the same
    // key (and therefore the same allowance) instead of creating new work.
    const requeues = Number((existing[0].checkpoint as { requeues?: number }).requeues ?? 0);
    if (requeues >= MAX_REQUEUES) return { job: existing[0], created: false };
    const requeued = await sql<JobRow[]>`
      update public.jobs set state = 'queued', attempts = 0, scheduled_at = now(), lease_until = null, worker_id = null,
             error_code = null, error_message = null, error_retryable = null, finished_at = null,
             checkpoint = checkpoint || ${sql.json({ requeues: requeues + 1 } as never)}, generation = ${input.generation}, updated_at = now()
       where id = ${existing[0].id} and state in ('failed', 'canceled') returning *`;
    if (requeued[0]) return { job: requeued[0], created: true };
  }
  return { job: existing[0], created: false };
}

export function jobStatusDto(job: JobRow): JobStatusDto {
  return {
    job_id: job.id,
    type: job.type,
    state: job.state,
    result_id: job.state === 'succeeded' ? job.result_id : null,
    result_kind: job.state === 'succeeded' ? (job.result_kind as JobStatusDto['result_kind']) : null,
    error:
      job.state === 'failed' || job.state === 'canceled'
        ? { code: job.error_code ?? 'failed', message: safeMessageFor(job.type, job.error_code), retryable: job.error_retryable ?? false }
        : null,
    updated_at: job.updated_at.toISOString(),
  };
}

/**
 * Fixed user-facing messages keyed by job type and error code. The raw
 * provider/internal message stays server-side in jobs.error_message.
 */
export function safeMessageFor(type: JobType, code: string | null): string {
  if (code === 'superseded_revision') return 'The transcript changed, so this step was replaced.';
  if (code === 'attempt_deleted' || code === 'account_deleting' || code === 'stale') return 'This practice is no longer available.';
  if (code === 'invalid_model_output') return type === 'rewrite' ? 'A rewrite couldn’t be validated this time.' : 'Feedback couldn’t finish yet.';
  if (code === 'provider_rate_limited') return 'The service is busy. Try again in a moment.';
  if (code === 'provider_denied') return 'The service is unavailable right now.';
  switch (type) {
    case 'transcribe':
      return 'Your recording is saved on this device. Try sending it again.';
    case 'evaluate':
    case 'roleplay_evaluate':
      return 'Your words are saved. Feedback couldn’t finish yet.';
    case 'rewrite':
      return 'A rewrite isn’t available right now. Your feedback is saved.';
    case 'speech':
      return 'Audio is unavailable right now.';
    case 'roleplay_turn':
      return 'The reply couldn’t be generated yet.';
    default:
      return 'This step couldn’t finish yet.';
  }
}

export async function getOwnedJob(ctx: ServerContext, userId: string, jobId: string): Promise<JobRow> {
  const rows = await ctx.sql<JobRow[]>`select * from public.jobs where id = ${jobId} and user_id = ${userId}`;
  if (!rows[0]) throw ApiError.notFound('Job not found.');
  return rows[0];
}
