import type { Actor, ServerContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import { getOwnedAttempt } from './attempts.js';
import { enqueueJob, type JobRow } from './jobs.js';
import { recomputeSkillProgress } from './progress.js';
import { releaseSession } from './allowance.js';

/** Recent authentication window for destructive account actions (seconds). */
export const RECENT_AUTH_SECONDS = 15 * 60;

/**
 * DELETE /attempts/:id: marks the attempt inaccessible immediately, cancels
 * its jobs, bumps its deletion generation so late worker results cannot
 * commit, and queues storage cleanup. Progress is recomputed from what
 * remains; removed transcript records are never recreated.
 */
export async function deleteAttempt(ctx: ServerContext, actor: Actor, attemptId: string): Promise<{ job: JobRow }> {
  const attempt = await getOwnedAttempt(ctx, actor.userId, attemptId);
  const session = (await ctx.sql<{ framework_id: string; status: string }[]>`select framework_id, status from public.practice_sessions where id = ${attempt.session_id}`)[0];
  return ctx.sql.begin(async (tx) => {
    await tx`update public.attempts set deleted_at = now(), stage = 'deleted', deletion_generation = deletion_generation + 1, updated_at = now() where id = ${attempt.id}`;
    await tx`select public.cancel_jobs_for_attempt(${attempt.id}, 'attempt_deleted')`;
    await tx`update public.jobs set checkpoint = '{}'::jsonb, payload = '{}'::jsonb, error_message = null, updated_at = now() where attempt_id = ${attempt.id} and type <> 'delete_attempt'`;
    await tx`
      update public.practice_sessions s set roleplay_state = jsonb_set(s.roleplay_state, '{exchanges}', (
          select coalesce(jsonb_agg(case when e->>'attempt_id' = ${attempt.id} then e || '{"learner_text":"","deleted":true}'::jsonb else e end order by (e->>'exchange')::int), '[]'::jsonb)
            from jsonb_array_elements(s.roleplay_state->'exchanges') e)), updated_at = now()
       where s.id = ${attempt.session_id} and s.roleplay_state is not null`;
    await tx`update public.audio_assets set state = 'deleted', deleted_at = now(), updated_at = now() where attempt_id = ${attempt.id} and deleted_at is null`;
    await tx`delete from public.skill_evidence where attempt_id = ${attempt.id}`;
    await tx`delete from public.completions where attempt_id = ${attempt.id}`;
    await tx`delete from public.practice_days where attempt_id = ${attempt.id}`;
    if (session) await recomputeSkillProgress(tx as never, actor.userId, session.framework_id, ctx.now());
    // A session whose only attempt is gone before completion releases its reservation.
    const remaining = await tx<{ n: number }[]>`select count(*)::int as n from public.attempts where session_id = ${attempt.session_id} and deleted_at is null`;
    if ((remaining[0]?.n ?? 0) === 0 && session?.status === 'active') {
      await releaseSession(tx as never, attempt.session_id);
      await tx`update public.practice_sessions set status = 'released', updated_at = now() where id = ${attempt.session_id} and status = 'active'`;
    }
    const { job } = await enqueueJob(tx as never, {
      userId: actor.userId,
      attemptId: attempt.id,
      sessionId: attempt.session_id,
      type: 'delete_attempt',
      generation: attempt.deletion_generation + 1,
      stageKey: `delete-attempt:${attempt.id}:${attempt.deletion_generation + 1}`,
      payload: {},
      maxAttempts: 5,
    });
    await tx`insert into public.deletion_jobs (user_id, generation, scope, attempt_id, state) values (${actor.userId}, ${attempt.deletion_generation + 1}, 'attempt', ${attempt.id}, 'requested')`;
    return { job };
  });
}

/**
 * POST /account/deletion: requires recent authentication, makes the account
 * inaccessible, revokes new access, cancels queued work and queues cleanup.
 */
export async function requestAccountDeletion(ctx: ServerContext, actor: Actor): Promise<{ deletion_job_id: string; job: JobRow }> {
  const nowSec = Math.floor(ctx.now().getTime() / 1000);
  if (actor.authTime === null || nowSec - actor.authTime > RECENT_AUTH_SECONDS) {
    throw new ApiError(403, 'recent_auth_required', 'Sign in again to delete your account.');
  }
  return ctx.sql.begin(async (tx) => {
    const gen = (await tx<{ bump_deletion_generation: number }[]>`select public.bump_deletion_generation(${actor.userId}, 'deleting')`)[0]!.bump_deletion_generation;
    await tx`update public.jobs set state = 'canceled', error_code = 'account_deleting', finished_at = now(), updated_at = now(), lease_until = null
       where user_id = ${actor.userId} and state in ('queued', 'running') and type not in ('delete_account', 'delete_attempt')`;
    await tx`update public.attempts set deleted_at = coalesce(deleted_at, now()), stage = 'deleted', updated_at = now() where user_id = ${actor.userId} and deleted_at is null`;
    await tx`update public.practice_sessions set status = 'deleted', deleted_at = now(), updated_at = now() where user_id = ${actor.userId} and deleted_at is null`;
    await tx`update public.audio_assets set state = 'deleted', deleted_at = now(), updated_at = now() where user_id = ${actor.userId} and deleted_at is null`;
    const dj = await tx<{ id: string }[]>`insert into public.deletion_jobs (user_id, generation, scope, state) values (${actor.userId}, ${gen}, 'account', 'requested') returning id`;
    const { job } = await enqueueJob(tx as never, {
      userId: actor.userId,
      type: 'delete_account',
      generation: gen,
      stageKey: `delete-account:${actor.userId}:${gen}`,
      payload: { deletion_job_id: dj[0]!.id },
      maxAttempts: 10,
    });
    return { deletion_job_id: dj[0]!.id, job };
  });
}
