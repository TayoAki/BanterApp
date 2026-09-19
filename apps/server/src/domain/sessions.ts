import type { CreateSessionRequest, SessionDto, SessionMode } from '@marshmemos/contracts';
import { ROLEPLAY_MAX_EXCHANGES } from '@marshmemos/contracts';
import { frameworkNumber } from '@marshmemos/content';
import type { Actor, ServerContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import { getAllowance, reserveSession } from './allowance.js';
import { getOrCreateAssignment } from './assignments.js';
import { getPlan } from './entitlements.js';

export const SESSION_LIMITS = {
  initial_recordings: 1,
  transcript_corrections: 1,
  guided_retries: 1,
  rewrites_per_evaluation: 1,
  speech_assets_per_rewrite: 1,
  roleplay_exchanges: ROLEPLAY_MAX_EXCHANGES,
} as const;

export interface SessionRow {
  id: string;
  user_id: string;
  assignment_id: string | null;
  mode: SessionMode;
  framework_id: string;
  framework_version: string;
  prompt_id: string;
  prompt_version: number;
  lesson_id: string | null;
  lesson_version: number | null;
  status: 'active' | 'completed' | 'released' | 'expired' | 'deleted';
  quota_window_date: string;
  client_key: string;
  roleplay_state: RoleplayState | null;
  deletion_generation: number;
  created_at: Date;
  completed_at: Date | null;
  deleted_at: Date | null;
}

export interface RoleplayState {
  scenario: string;
  partner_name: string;
  partner_facts: string;
  exchanges: Array<{
    exchange: number;
    attempt_id: string;
    transcript_revision: number;
    learner_text: string;
    partner_reply: string | null;
    conversation_state: 'continuing' | 'ended' | null;
    boundary_signal: 'none' | 'uncertain' | 'disengaged' | null;
    partner_speech_asset_id: string | null;
    job_id: string | null;
  }>;
  ended: boolean;
  session_evaluation_id: string | null;
}

const PARTNER_NAMES = ['Sam', 'Jordan', 'Priya', 'Alex', 'Noor', 'Dani', 'Theo', 'Maya'];

export function initialRoleplayState(prompt: string, sessionId: string): RoleplayState {
  const idx = Number.parseInt(sessionId.replace(/-/g, '').slice(0, 6), 16) % PARTNER_NAMES.length;
  return {
    scenario: prompt,
    partner_name: PARTNER_NAMES[idx]!,
    partner_facts:
      'A fictional adult acquaintance in the scenario. Has their own plans and opinions, may be playful, neutral, or uninterested, and can end the conversation. No real-person likeness.',
    exchanges: [],
    ended: false,
    session_evaluation_id: null,
  };
}

export async function getOwnedSession(ctx: ServerContext, userId: string, sessionId: string): Promise<SessionRow> {
  const rows = await ctx.sql<SessionRow[]>`
    select *, quota_window_date::text as quota_window_date from public.practice_sessions
     where id = ${sessionId} and user_id = ${userId} and deleted_at is null`;
  if (!rows[0]) throw ApiError.notFound('Session not found.');
  return rows[0];
}

export async function sessionDto(ctx: ServerContext, actor: Actor, row: SessionRow, created: boolean): Promise<SessionDto> {
  const prompt = ctx.catalog.promptsById.get(row.prompt_id);
  if (!prompt) throw ApiError.unavailable('Prompt content unavailable.');
  const fw = ctx.catalog.framework(row.framework_id);
  return {
    session_id: row.id,
    mode: row.mode,
    status: row.status,
    framework_id: row.framework_id as SessionDto['framework_id'],
    framework_number: frameworkNumber(row.framework_id),
    app_title: fw?.config.app_title ?? row.framework_id,
    rubric_version: row.framework_version,
    prompt: ctx.catalog.promptDto(prompt),
    limits: { ...SESSION_LIMITS },
    allowance: await getAllowance(ctx, actor.userId),
    created,
  };
}

/**
 * POST /sessions. Idempotent per (owner, client_key). Reserves one allowance
 * unit in the same transaction that creates the session; a quota failure
 * rolls the session back and returns 429.
 */
export async function createSession(ctx: ServerContext, actor: Actor, req: CreateSessionRequest): Promise<{ row: SessionRow; created: boolean }> {
  const existing = await ctx.sql<SessionRow[]>`
    select *, quota_window_date::text as quota_window_date from public.practice_sessions
     where user_id = ${actor.userId} and client_key = ${req.client_key}`;
  if (existing[0]) return { row: existing[0], created: false };

  const viewer = { editor: actor.editor };
  let promptId: string;
  let promptVersion: number;
  let assignmentId: string | null = null;
  if (req.assignment_id) {
    const { assignment } = await getOrCreateAssignment(ctx, actor);
    const rows = await ctx.sql<{ id: string; prompt_id: string; prompt_version: number }[]>`
      select id, prompt_id, prompt_version from public.daily_assignments where id = ${req.assignment_id} and user_id = ${actor.userId}`;
    const a = rows[0];
    if (!a) throw ApiError.notFound('Assignment not found.');
    if (assignment && assignment.id !== a.id) {
      // Allowed: finishing yesterday's assignment is fine, but it must be the learner's own.
    }
    assignmentId = a.id;
    promptId = a.prompt_id;
    promptVersion = a.prompt_version;
  } else if (req.prompt_id && req.prompt_version !== undefined) {
    const p = ctx.catalog.visiblePrompt(req.prompt_id, viewer);
    if (!p || p.seed.version !== req.prompt_version) throw ApiError.notFound('Prompt not found.');
    promptId = p.seed.id;
    promptVersion = p.seed.version;
  } else {
    throw ApiError.validation('Provide assignment_id or prompt_id with prompt_version.');
  }
  const promptEntry = ctx.catalog.promptsById.get(promptId);
  if (!promptEntry) throw ApiError.notFound('Prompt not found.');
  const fw = ctx.catalog.framework(promptEntry.seed.framework_id)!;

  const plan = await getPlan(ctx, actor.userId);
  if (req.mode === 'mixed' && plan !== 'pro') throw new ApiError(403, 'pro_required', 'Mixed-skill practice is part of Pro.');
  if (req.mode === 'roleplay' && promptEntry.seed.kind !== 'fictional_roleplay') {
    throw ApiError.validation('Roleplay sessions require a fictional practice prompt.');
  }

  const row = await ctx.sql.begin(async (tx) => {
    const inserted = await tx<SessionRow[]>`
      insert into public.practice_sessions (user_id, assignment_id, mode, framework_id, framework_version, prompt_id, prompt_version, status,
        quota_window_date, client_key, deletion_generation)
      values (${actor.userId}, ${assignmentId}, ${req.mode}, ${fw.config.id}, ${fw.config.rubric_version}, ${promptId}, ${promptVersion}, 'active',
        ${ctx.now().toISOString().slice(0, 10)}, ${req.client_key}, ${actor.deletionGeneration})
      returning *, quota_window_date::text as quota_window_date`;
    const s = inserted[0]!;
    await reserveSession(ctx, tx as unknown as typeof ctx.sql, actor.userId, s.id, plan);
    if (req.mode === 'roleplay') {
      const state = initialRoleplayState(promptEntry.seed.prompt, s.id);
      await tx`update public.practice_sessions set roleplay_state = ${tx.json(state as never)} where id = ${s.id}`;
      s.roleplay_state = state;
    }
    return s;
  });
  return { row, created: true };
}

export async function markSessionCompleted(sql: ServerContext['sql'], sessionId: string): Promise<void> {
  await sql`update public.practice_sessions set status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now()
     where id = ${sessionId} and status = 'active'`;
}

/**
 * A session released after a system failure is reactivated (and its
 * allowance re-reserved) when the learner resumes it. Throws 429 when the
 * window is now full.
 */
export async function ensureSessionReservation(ctx: ServerContext, actor: Actor, session: SessionRow): Promise<void> {
  if (session.status !== 'released' && session.status !== 'expired') return;
  const plan = await getPlan(ctx, actor.userId);
  await ctx.sql.begin(async (tx) => {
    await reserveSession(ctx, tx as unknown as typeof ctx.sql, actor.userId, session.id, plan);
    await tx`update public.practice_sessions set status = 'active', updated_at = now() where id = ${session.id} and status in ('released', 'expired')`;
  });
}
