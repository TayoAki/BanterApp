import type { AllowanceDto } from '@marshmemos/contracts';
import type { ServerContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import { nextUtcMidnight, utcDate } from '../time.js';
import { getPlan, type Plan } from './entitlements.js';

export function allowedSessionsFor(ctx: ServerContext, plan: Plan): number {
  return plan === 'pro' ? ctx.config.PRO_SESSIONS_PER_UTC_DAY : ctx.config.FREE_SESSIONS_PER_UTC_DAY;
}

export function scopeFor(plan: Plan): string[] {
  const base = [
    'one recording and one corrected transcript per session',
    'one guided retry per session',
    'one rewrite per evaluated attempt',
    'one generated playback per rewrite; replays are free',
  ];
  return plan === 'pro' ? [...base, 'mixed-skill practice'] : base;
}

export async function getAllowance(ctx: ServerContext, userId: string): Promise<AllowanceDto> {
  const plan = await getPlan(ctx, userId);
  const now = ctx.now();
  const window = utcDate(now);
  const rows = await ctx.sql<{ allowed_sessions: number; reserved: number; committed: number }[]>`
    select allowed_sessions, reserved, committed from public.quota_windows where user_id = ${userId} and window_date = ${window}`;
  const allowed = Math.max(rows[0]?.allowed_sessions ?? 0, allowedSessionsFor(ctx, plan));
  const reserved = rows[0]?.reserved ?? 0;
  const committed = rows[0]?.committed ?? 0;
  return {
    plan,
    allowed_sessions: allowed,
    reserved,
    committed,
    remaining: Math.max(allowed - reserved - committed, 0),
    resets_at: nextUtcMidnight(now).toISOString(),
    scope: scopeFor(plan),
  };
}

/** Reserve one session in the current UTC window; throws 429 when the cap is reached. */
export async function reserveSession(ctx: ServerContext, tx: typeof ctx.sql, userId: string, sessionId: string, plan: Plan): Promise<{ window: string; reservationId: string }> {
  const window = utcDate(ctx.now());
  try {
    const rows = await tx<{ reservation_id: string }[]>`
      select reservation_id from public.reserve_session_allowance(${userId}, ${sessionId}, ${window}, ${allowedSessionsFor(ctx, plan)},
        ${`${ctx.config.RESERVATION_TTL_MINUTES} minutes`}::interval)`;
    return { window, reservationId: rows[0]!.reservation_id };
  } catch (err) {
    if (err instanceof Error && /quota_exceeded/.test(err.message)) {
      const allowance = await getAllowance(ctx, userId);
      throw ApiError.quota('Today’s practice allowance is used.', { allowance: allowance as unknown as Record<string, unknown> });
    }
    throw err;
  }
}

export async function commitSession(sql: ServerContext['sql'], sessionId: string): Promise<void> {
  await sql`select public.commit_session_allowance(${sessionId})`;
}

export async function releaseSession(sql: ServerContext['sql'], sessionId: string): Promise<void> {
  await sql`select public.release_session_allowance(${sessionId})`;
}
