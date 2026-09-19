import type { ComparisonResponse, FrameworkId, ProgressResponse, ScoreTotals, SkillState } from '@marshmemos/contracts';
import { compareEvaluations, type Evaluation } from '@marshmemos/contracts';
import { curriculumIndex, frameworkNumber } from '@marshmemos/content';
import type { Actor, ServerContext } from '../context.js';
import type { Db } from '../db/client.js';
import { ApiError } from '../http/errors.js';
import { addDays, daysBetween, hoursBetween, localDate } from '../time.js';
import { getOwnedSession } from './sessions.js';

/** Pilot heuristics from docs/01-product.md; not validated schedules. */
export const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14] as const;
export const COMPLETION_XP = 10;
export const MASTERY_MIN_HOURS_APART = 24;

export interface SkillProgressRow {
  user_id: string;
  framework_id: FrameworkId;
  state: SkillState;
  review_step: number;
  next_due_at: Date | null;
  last_practiced_at: Date | null;
  last_qualified_at: Date | null;
  qualifying_attempts: number;
}

export async function skillStateRows(ctx: ServerContext, userId: string): Promise<SkillProgressRow[]> {
  return ctx.sql<SkillProgressRow[]>`select * from public.skill_progress where user_id = ${userId}`;
}

/** Consecutive server-confirmed practice days ending today or yesterday (local). */
export async function computeStreak(ctx: ServerContext, userId: string, todayLocal: string): Promise<number> {
  const rows = await ctx.sql<{ local_day: string }[]>`
    select local_day::text as local_day from public.practice_days where user_id = ${userId} order by local_day desc limit 400`;
  const days = new Set(rows.map((r) => r.local_day));
  let cursor = days.has(todayLocal) ? todayLocal : addDays(todayLocal, -1);
  if (!days.has(cursor)) return 0;
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

interface EvidenceInput {
  userId: string;
  frameworkId: FrameworkId;
  rubricVersion: string;
  attemptId: string;
  evaluationId: string;
  promptId: string;
  sessionId: string;
  lessonId: string | null;
  lessonVersion: number | null;
  guided: boolean;
  masteryQualifies: boolean;
  status: string;
  confidence: string;
  sourceCopy: boolean;
  displayedTotal: number | null;
  timezone: string;
  occurredAt: Date;
}

/**
 * Records skill evidence for a valid evaluation and derives progress:
 * - completion XP once per lesson version (retries do not farm XP);
 * - practice day for streaks (one per local day);
 * - mastery: two unassisted qualifying attempts on different prompts at
 *   least 24h apart, no source copy, no low confidence;
 * - review intervals 1/3/7/14 days after a successful independent review;
 *   a miss returns to next-day review.
 * A guided retry never independently completes mastery.
 */
export async function recordEvidence(sql: Db, input: EvidenceInput): Promise<{ state: SkillState; xpAwarded: number }> {
  const usable = input.status === 'scored' || input.status === 'uncertain';
  const qualifies = input.masteryQualifies && !input.sourceCopy && input.confidence !== 'low' && input.status === 'scored';
  await sql`
    insert into public.skill_evidence (user_id, framework_id, rubric_version, attempt_id, evaluation_id, prompt_id, guided, qualifies, source_copy, displayed_total, occurred_at)
    values (${input.userId}, ${input.frameworkId}, ${input.rubricVersion}, ${input.attemptId}, ${input.evaluationId}, ${input.promptId}, ${input.guided}, ${qualifies}, ${input.sourceCopy}, ${input.displayedTotal}, ${input.occurredAt})
    on conflict (attempt_id, rubric_version) do nothing`;

  let xpAwarded = 0;
  if (usable && !input.guided) {
    const localDay = localDate(input.occurredAt, input.timezone);
    const day = await sql<{ local_day: string }[]>`
      insert into public.practice_days (user_id, local_day, attempt_id, xp) values (${input.userId}, ${localDay}, ${input.attemptId}, 0)
      on conflict (user_id, local_day) do nothing returning local_day::text as local_day`;
    void day;
    if (input.lessonId && input.lessonVersion !== null) {
      const inserted = await sql<{ xp: number }[]>`
        insert into public.completions (user_id, lesson_id, lesson_version, attempt_id, local_day, xp)
        values (${input.userId}, ${input.lessonId}, ${input.lessonVersion}, ${input.attemptId}, ${localDay}, ${COMPLETION_XP})
        on conflict (user_id, lesson_id, lesson_version) do nothing returning xp`;
      xpAwarded = inserted[0]?.xp ?? 0;
    } else {
      // Daily practice without a lesson: award completion XP once per practice day.
      const updated = await sql<{ xp: number }[]>`
        update public.practice_days set xp = ${COMPLETION_XP} where user_id = ${input.userId} and local_day = ${localDay} and xp = 0 and attempt_id = ${input.attemptId} returning xp`;
      xpAwarded = updated[0]?.xp ?? 0;
    }
  }

  const current = (await sql<SkillProgressRow[]>`
    select * from public.skill_progress where user_id = ${input.userId} and framework_id = ${input.frameworkId} for update`)[0];

  let state: SkillState = current?.state ?? 'new';
  let reviewStep = current?.review_step ?? 0;
  let nextDue: Date | null = current?.next_due_at ?? null;
  let qualifyingAttempts = current?.qualifying_attempts ?? 0;
  let lastQualified = current?.last_qualified_at ?? null;

  if (usable && state === 'new') state = 'developing';

  if (qualifies && !input.guided) {
    const prior = await sql<{ prompt_id: string; occurred_at: Date }[]>`
      select prompt_id, occurred_at from public.skill_evidence
       where user_id = ${input.userId} and framework_id = ${input.frameworkId} and qualifies = true and guided = false and attempt_id <> ${input.attemptId}
       order by occurred_at desc`;
    qualifyingAttempts = prior.length + 1;
    lastQualified = input.occurredAt;
    const independentPair = prior.some(
      (p) => p.prompt_id !== input.promptId && hoursBetween(p.occurred_at, input.occurredAt) >= MASTERY_MIN_HOURS_APART,
    );
    if (state === 'review_due') {
      // Successful independent review: advance the interval.
      reviewStep = Math.min(reviewStep + 1, REVIEW_INTERVAL_DAYS.length - 1);
      state = 'ready';
      nextDue = new Date(input.occurredAt.getTime() + REVIEW_INTERVAL_DAYS[reviewStep]! * 86_400_000);
    } else if (independentPair && (state === 'developing' || state === 'ready')) {
      if (state === 'developing') reviewStep = 0;
      state = 'ready';
      nextDue = new Date(input.occurredAt.getTime() + REVIEW_INTERVAL_DAYS[reviewStep]! * 86_400_000);
    }
  } else if (usable && !input.guided && state === 'review_due') {
    // A missed (non-qualifying) review returns to next-day review.
    reviewStep = 0;
    nextDue = new Date(input.occurredAt.getTime() + REVIEW_INTERVAL_DAYS[0] * 86_400_000);
  }

  await sql`
    insert into public.skill_progress (user_id, framework_id, state, review_step, next_due_at, last_practiced_at, last_qualified_at, qualifying_attempts, updated_at)
    values (${input.userId}, ${input.frameworkId}, ${state}, ${reviewStep}, ${nextDue}, ${input.occurredAt}, ${lastQualified}, ${qualifyingAttempts}, now())
    on conflict (user_id, framework_id) do update set state = excluded.state, review_step = excluded.review_step, next_due_at = excluded.next_due_at,
      last_practiced_at = excluded.last_practiced_at, last_qualified_at = excluded.last_qualified_at, qualifying_attempts = excluded.qualifying_attempts, updated_at = now()`;
  return { state, xpAwarded };
}

/** Marks skills whose review date passed as review_due (idempotent; run on reads). */
export async function refreshDueStates(sql: Db, userId: string, now: Date): Promise<void> {
  await sql`update public.skill_progress set state = 'review_due', updated_at = now()
     where user_id = ${userId} and state = 'ready' and next_due_at is not null and next_due_at <= ${now}`;
}

/**
 * Recomputes skill_progress for a framework from remaining evidence after a
 * deletion. Never recreates removed transcript records; only aggregates.
 */
export async function recomputeSkillProgress(sql: Db, userId: string, frameworkId: string, now: Date): Promise<void> {
  const evidence = await sql<{ prompt_id: string; occurred_at: Date; qualifies: boolean; guided: boolean }[]>`
    select e.prompt_id, e.occurred_at, e.qualifies, e.guided from public.skill_evidence e
      join public.attempts a on a.id = e.attempt_id
     where e.user_id = ${userId} and e.framework_id = ${frameworkId} and a.deleted_at is null order by e.occurred_at`;
  if (evidence.length === 0) {
    await sql`delete from public.skill_progress where user_id = ${userId} and framework_id = ${frameworkId}`;
    return;
  }
  const qualifying = evidence.filter((e) => e.qualifies && !e.guided);
  let ready = false;
  for (let i = 0; i < qualifying.length && !ready; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const a = qualifying[j]!;
      const b = qualifying[i]!;
      if (a.prompt_id !== b.prompt_id && hoursBetween(a.occurred_at, b.occurred_at) >= MASTERY_MIN_HOURS_APART) ready = true;
    }
  }
  const last = evidence.at(-1)!;
  const state: SkillState = ready ? (last.occurred_at.getTime() + REVIEW_INTERVAL_DAYS[0] * 86_400_000 <= now.getTime() ? 'review_due' : 'ready') : 'developing';
  const nextDue = ready ? new Date(last.occurred_at.getTime() + REVIEW_INTERVAL_DAYS[0] * 86_400_000) : null;
  await sql`
    insert into public.skill_progress (user_id, framework_id, state, review_step, next_due_at, last_practiced_at, last_qualified_at, qualifying_attempts, updated_at)
    values (${userId}, ${frameworkId}, ${state}, 0, ${nextDue}, ${last.occurred_at}, ${qualifying.at(-1)?.occurred_at ?? null}, ${qualifying.length}, now())
    on conflict (user_id, framework_id) do update set state = excluded.state, review_step = 0, next_due_at = excluded.next_due_at,
      last_practiced_at = excluded.last_practiced_at, last_qualified_at = excluded.last_qualified_at, qualifying_attempts = excluded.qualifying_attempts, updated_at = now()`;
}

export async function progressResponse(ctx: ServerContext, actor: Actor, cursor: string | null): Promise<ProgressResponse> {
  const now = ctx.now();
  await refreshDueStates(ctx.sql, actor.userId, now);
  const profileTz = (await ctx.sql<{ timezone: string }[]>`select timezone from public.profiles where id = ${actor.userId}`)[0]?.timezone ?? 'UTC';
  const today = localDate(now, profileTz);
  const skills = await skillStateRows(ctx, actor.userId);
  const byId = new Map(skills.map((s) => [s.framework_id, s]));
  const xp = await ctx.sql<{ total: number }[]>`
    select coalesce((select sum(xp) from public.completions where user_id = ${actor.userId}), 0)
         + coalesce((select sum(xp) from public.practice_days where user_id = ${actor.userId}), 0) as total`;
  const practices = await ctx.sql<{ n: number }[]>`
    select count(*)::int as n from public.skill_evidence e join public.attempts a on a.id = e.attempt_id where e.user_id = ${actor.userId} and a.deleted_at is null`;
  const limit = 20;
  const history = await ctx.sql<
    { session_id: string; attempt_id: string; framework_id: FrameworkId; local_day: string; displayed_total: number | null; is_guided_retry: boolean; retry_of: string | null; evaluation_id: string | null; created_at: Date; total_maximum: number }[]
  >`
    select a.session_id, a.id as attempt_id, s.framework_id, (e.created_at at time zone ${profileTz})::date::text as local_day,
           (e.totals->>'displayed_total')::int as displayed_total, (e.totals->>'total_maximum')::int as total_maximum,
           a.is_guided_retry, a.retry_of, e.id as evaluation_id, e.created_at
      from public.evaluations e
      join public.attempts a on a.id = e.attempt_id
      join public.practice_sessions s on s.id = a.session_id
     where e.user_id = ${actor.userId} and e.kind = 'attempt' and a.deleted_at is null
       and e.transcript_revision = a.current_revision
       ${cursor ? ctx.sql`and e.created_at < ${new Date(cursor)}` : ctx.sql``}
     order by e.created_at desc limit ${limit + 1}`;
  const page = history.slice(0, limit);
  const frameworks = ctx.catalog.visibleFrameworks({ editor: actor.editor });
  return {
    xp_total: Number(xp[0]?.total ?? 0),
    streak_days: await computeStreak(ctx, actor.userId, today),
    practices_completed: practices[0]?.n ?? 0,
    skills: frameworks
      .map((f) => {
        const s = byId.get(f.config.id);
        return {
          framework_id: f.config.id,
          framework_number: frameworkNumber(f.config.id),
          app_title: f.config.app_title,
          state: s?.state ?? ('new' as SkillState),
          review_step: s?.review_step ?? 0,
          next_due_at: s?.next_due_at?.toISOString() ?? null,
          last_practiced_at: s?.last_practiced_at?.toISOString() ?? null,
          qualifying_attempts: s?.qualifying_attempts ?? 0,
        };
      })
      .sort((a, b) => curriculumIndex(a.framework_id) - curriculumIndex(b.framework_id)),
    due_reviews: skills
      .filter((s) => s.state === 'review_due' && s.next_due_at)
      .sort((a, b) => a.next_due_at!.getTime() - b.next_due_at!.getTime())
      .slice(0, 3)
      .map((s) => ({ framework_id: s.framework_id, app_title: ctx.catalog.framework(s.framework_id)?.config.app_title ?? s.framework_id, due_at: s.next_due_at!.toISOString() })),
    history: page.map((h) => ({
      session_id: h.session_id,
      attempt_id: h.attempt_id,
      framework_id: h.framework_id,
      app_title: ctx.catalog.framework(h.framework_id)?.config.app_title ?? h.framework_id,
      local_day: h.local_day,
      displayed_total: h.displayed_total,
      total_maximum: h.total_maximum,
      is_guided_retry: h.is_guided_retry,
      retry_of: h.retry_of,
      evaluation_id: h.evaluation_id,
      created_at: h.created_at.toISOString(),
    })),
    next_cursor: history.length > limit ? page.at(-1)!.created_at.toISOString() : null,
  };
}

export async function comparisonResponse(ctx: ServerContext, actor: Actor, sessionId: string): Promise<ComparisonResponse> {
  const session = await getOwnedSession(ctx, actor.userId, sessionId);
  const fw = ctx.catalog.framework(session.framework_id);
  const attempts = await ctx.sql<{ id: string; ordinal: number; retry_of: string | null; is_guided_retry: boolean; current_revision: number }[]>`
    select id, ordinal, retry_of, is_guided_retry, current_revision from public.attempts where session_id = ${session.id} and deleted_at is null order by ordinal`;
  const first = attempts.find((a) => a.retry_of === null) ?? null;
  const retry = attempts.find((a) => a.retry_of !== null) ?? null;
  const labels = new Map(fw?.config.criteria.map((c) => [c.id, c.label]) ?? []);
  const evalFor = async (a: { id: string; current_revision: number } | null) => {
    if (!a) return null;
    const rows = await ctx.sql<{ id: string; result: Evaluation; totals: ScoreTotals; transcript_revision: number }[]>`
      select id, result, totals, transcript_revision from public.evaluations where attempt_id = ${a.id} and kind = 'attempt' and transcript_revision = ${a.current_revision}
       order by created_at desc limit 1`;
    return rows[0] ?? null;
  };
  const firstEval = await evalFor(first);
  const retryEval = await evalFor(retry);
  const progress = (await ctx.sql<SkillProgressRow[]>`select * from public.skill_progress where user_id = ${actor.userId} and framework_id = ${session.framework_id}`)[0];
  const base = {
    session_id: session.id,
    framework_id: session.framework_id as FrameworkId,
    app_title: fw?.config.app_title ?? session.framework_id,
    rubric_version: session.framework_version,
    next_review_at: progress?.next_due_at?.toISOString() ?? null,
  };
  const masteryNote = retry?.is_guided_retry ? 'Guided retry · mastery still developing' : progress?.state === 'ready' ? 'Independent practice recorded' : 'Mastery still developing';
  if (!firstEval) {
    return { ...base, first: null, retry: null, state: 'no_comparable_result', per_criterion: [], mastery_note: masteryNote };
  }
  const firstDto = { attempt_id: first!.id, evaluation_id: firstEval.id, displayed_total: firstEval.totals.displayed_total, total_maximum: firstEval.totals.total_maximum };
  if (!retry) return { ...base, first: firstDto, retry: null, state: 'retry_unavailable', per_criterion: [], mastery_note: masteryNote };
  if (!retryEval) return { ...base, first: firstDto, retry: null, state: 'no_comparable_result', per_criterion: [], mastery_note: masteryNote };
  const cmp = compareEvaluations({ evaluation: firstEval.result, totals: firstEval.totals }, { evaluation: retryEval.result, totals: retryEval.totals });
  return {
    ...base,
    first: firstDto,
    retry: { attempt_id: retry.id, evaluation_id: retryEval.id, displayed_total: retryEval.totals.displayed_total, total_maximum: retryEval.totals.total_maximum, guided: retry.is_guided_retry },
    state: cmp.comparable ? 'ready' : 'no_comparable_result',
    per_criterion: cmp.per_criterion.map((c) => ({ ...c, label: labels.get(c.criterion_id) ?? c.criterion_id })),
    mastery_note: masteryNote,
  };
}

export function daysSince(aYmd: string, bYmd: string): number {
  return daysBetween(aYmd, bYmd);
}

export { ApiError };
