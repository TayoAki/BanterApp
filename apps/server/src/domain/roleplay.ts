import type { RoleplayStateDto, RoleplayTurnRequest } from '@marshmemos/contracts';
import { ROLEPLAY_MAX_EXCHANGES } from '@marshmemos/contracts';
import type { Actor, ServerContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import { getOwnedAttempt, getRevision } from './attempts.js';
import { enqueueJob, type JobRow } from './jobs.js';
import { getOwnedSession, type RoleplayState, type SessionRow } from './sessions.js';

export function roleplayStateDto(session: SessionRow): RoleplayStateDto {
  const state = session.roleplay_state;
  if (!state) throw ApiError.conflict('This session is not a roleplay.');
  const completed = state.exchanges.filter((e) => e.partner_reply !== null).length;
  return {
    session_id: session.id,
    scenario: state.scenario,
    partner_name: state.partner_name,
    exchanges: state.exchanges.map((e) => ({
      exchange: e.exchange,
      attempt_id: e.attempt_id,
      learner_text: e.learner_text,
      partner_reply: e.partner_reply,
      conversation_state: e.conversation_state,
      boundary_signal: e.boundary_signal,
      partner_speech_asset_id: e.partner_speech_asset_id,
    })),
    exchanges_remaining: state.ended ? 0 : Math.max(ROLEPLAY_MAX_EXCHANGES - completed, 0),
    ended: state.ended,
    session_evaluation_id: state.session_evaluation_id,
  };
}

/**
 * POST /sessions/:id/roleplay-turn. Each spoken learner turn must be a
 * confirmed transcript revision of an attempt in this session. The exchange
 * number is idempotent: repeating a turn returns the existing job.
 */
export async function requestRoleplayTurn(ctx: ServerContext, actor: Actor, sessionId: string, req: RoleplayTurnRequest): Promise<{ job: JobRow; created: boolean; state: RoleplayState }> {
  const session = await getOwnedSession(ctx, actor.userId, sessionId);
  if (session.mode !== 'roleplay' || !session.roleplay_state) throw ApiError.conflict('This session is not a roleplay.');
  if (session.status !== 'active') throw ApiError.conflict(`Session is ${session.status}.`);
  const state = session.roleplay_state;
  if (state.ended) throw ApiError.conflict('The conversation has ended.');
  const attempt = await getOwnedAttempt(ctx, actor.userId, req.attempt_id);
  if (attempt.session_id !== session.id) throw ApiError.notFound('Attempt not found in this session.');
  if (attempt.current_revision < 1 || attempt.current_revision !== req.transcript_revision) {
    throw ApiError.conflict('Confirm the transcript for this turn first.', { current_revision: attempt.current_revision });
  }
  const existing = state.exchanges.find((e) => e.exchange === req.expected_exchange);
  if (existing) {
    if (existing.attempt_id !== attempt.id) throw ApiError.conflict('This exchange already used a different attempt.');
    const job = existing.job_id ? (await ctx.sql<JobRow[]>`select * from public.jobs where id = ${existing.job_id}`)[0] : undefined;
    if (job) return { job, created: false, state };
  }
  const nextExchange = state.exchanges.length + 1;
  if (req.expected_exchange !== nextExchange) throw ApiError.conflict(`Expected exchange ${nextExchange}.`, { expected_exchange: nextExchange });
  if (nextExchange > ROLEPLAY_MAX_EXCHANGES) throw ApiError.quota('This conversation has reached its three-exchange limit.');
  if (state.exchanges.some((e) => e.attempt_id === attempt.id)) throw ApiError.conflict('This attempt was already used for a turn.');
  const revision = await getRevision(ctx, attempt.id, attempt.current_revision);
  if (!revision?.confirmed_text) throw ApiError.conflict('Confirm the transcript for this turn first.');

  return ctx.sql.begin(async (tx) => {
    const { job, created } = await enqueueJob(tx as never, {
      userId: actor.userId,
      attemptId: attempt.id,
      sessionId: session.id,
      type: 'roleplay_turn',
      transcriptRevision: attempt.current_revision,
      generation: actor.deletionGeneration,
      stageKey: `roleplay:${session.id}:${nextExchange}`,
      payload: { exchange: nextExchange, attempt_id: attempt.id, transcript_revision: attempt.current_revision },
    });
    const newState: RoleplayState = {
      ...state,
      exchanges: [
        ...state.exchanges,
        {
          exchange: nextExchange,
          attempt_id: attempt.id,
          transcript_revision: attempt.current_revision,
          learner_text: revision.confirmed_text!,
          partner_reply: null,
          conversation_state: null,
          boundary_signal: null,
          partner_speech_asset_id: null,
          job_id: job.id,
        },
      ],
    };
    await tx`update public.practice_sessions set roleplay_state = ${tx.json(newState as never)}, updated_at = now() where id = ${session.id} and roleplay_state = ${tx.json(state as never)}`;
    return { job, created, state: newState };
  });
}

/** POST /sessions/:id/roleplay-finish: ends the conversation and queues the single session evaluation. */
export async function finishRoleplay(ctx: ServerContext, actor: Actor, sessionId: string): Promise<{ job: JobRow | null; state: RoleplayState }> {
  const session = await getOwnedSession(ctx, actor.userId, sessionId);
  if (session.mode !== 'roleplay' || !session.roleplay_state) throw ApiError.conflict('This session is not a roleplay.');
  const state = session.roleplay_state;
  const completed = state.exchanges.filter((e) => e.partner_reply !== null);
  if (completed.length === 0) throw ApiError.conflict('Complete at least one exchange before finishing.');
  if (state.exchanges.some((e) => e.partner_reply === null)) throw ApiError.conflict('A partner reply is still being generated.');
  const last = completed.at(-1)!;
  return ctx.sql.begin(async (tx) => {
    const { job } = await enqueueJob(tx as never, {
      userId: actor.userId,
      attemptId: last.attempt_id,
      sessionId: session.id,
      type: 'roleplay_evaluate',
      transcriptRevision: last.transcript_revision,
      generation: actor.deletionGeneration,
      stageKey: `roleplay-eval:${session.id}`,
      payload: { exchanges: completed.length },
    });
    const newState: RoleplayState = { ...state, ended: true };
    await tx`update public.practice_sessions set roleplay_state = ${tx.json(newState as never)}, updated_at = now() where id = ${session.id}`;
    return { job, state: newState };
  });
}
