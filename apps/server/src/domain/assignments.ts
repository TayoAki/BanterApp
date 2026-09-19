import type { AttemptStage, FrameworkId, TodayResponse } from '@marshmemos/contracts';
import { CURRICULUM_ORDER, curriculumIndex, frameworkNumber } from '@marshmemos/content';
import type { Actor, ServerContext } from '../context.js';
import { localDate } from '../time.js';
import { getAllowance } from './allowance.js';
import { getProfile } from './profiles.js';
import { computeStreak, skillStateRows } from './progress.js';

export interface AssignmentRow {
  id: string;
  user_id: string;
  local_date: string;
  timezone_snapshot: string;
  framework_id: FrameworkId;
  framework_version: string;
  prompt_id: string;
  prompt_version: number;
  reason: 'review_due' | 'next_unit' | 'least_recent';
}

interface Selection {
  framework_id: FrameworkId;
  prompt_id: string;
  prompt_version: number;
  framework_version: string;
  reason: AssignmentRow['reason'];
}

/**
 * Selection rule (docs/01-product.md): most overdue learned skill; otherwise
 * the next unlocked unit; otherwise the least-recently-practiced learned
 * skill. Ties break by curriculum order, then stable prompt ID. Prefer a
 * prompt not used in the last seven practice days.
 */
export async function selectAssignment(ctx: ServerContext, actor: Actor, localDay: string): Promise<Selection | null> {
  const viewer = { editor: actor.editor };
  const skills = await skillStateRows(ctx, actor.userId);
  const now = ctx.now();
  const byId = new Map(skills.map((s) => [s.framework_id, s]));
  const hasPrompts = (fw: FrameworkId) => ctx.catalog.visiblePromptsFor(fw, viewer).length > 0;

  const candidates: Array<{ framework_id: FrameworkId; reason: Selection['reason'] }> = [];
  // a) most overdue learned skill
  const due = skills
    .filter((s) => s.state !== 'new' && s.next_due_at !== null && s.next_due_at <= now && hasPrompts(s.framework_id))
    .sort((a, b) => a.next_due_at!.getTime() - b.next_due_at!.getTime() || curriculumIndex(a.framework_id) - curriculumIndex(b.framework_id));
  if (due[0]) candidates.push({ framework_id: due[0].framework_id, reason: 'review_due' });
  // b) next unlocked unit (first curriculum framework never learned)
  const next = CURRICULUM_ORDER.find((fw) => (byId.get(fw)?.state ?? 'new') === 'new' && hasPrompts(fw));
  if (next) candidates.push({ framework_id: next, reason: 'next_unit' });
  // c) least recently practiced learned skill
  const learned = skills
    .filter((s) => s.state !== 'new' && hasPrompts(s.framework_id))
    .sort(
      (a, b) =>
        (a.last_practiced_at?.getTime() ?? 0) - (b.last_practiced_at?.getTime() ?? 0) ||
        curriculumIndex(a.framework_id) - curriculumIndex(b.framework_id),
    );
  if (learned[0]) candidates.push({ framework_id: learned[0].framework_id, reason: 'least_recent' });
  const pick = candidates[0];
  if (!pick) return null;

  const prompts = ctx.catalog
    .visiblePromptsFor(pick.framework_id, viewer)
    .slice()
    .sort((a, b) => a.seed.id.localeCompare(b.seed.id));
  if (prompts.length === 0) return null;

  // Recent usage: prompts used on the last seven distinct practice days.
  const recent = await ctx.sql<{ prompt_id: string; last_used: string }[]>`
    select prompt_id, max(local_date)::text as last_used from public.daily_assignments
     where user_id = ${actor.userId} and local_date >= (${localDay}::date - interval '7 days')::date and local_date < ${localDay}::date
     group by prompt_id`;
  const recentIds = new Set(recent.map((r) => r.prompt_id));
  const everUsed = await ctx.sql<{ prompt_id: string; last_used: string }[]>`
    select prompt_id, max(local_date)::text as last_used from public.daily_assignments
     where user_id = ${actor.userId} group by prompt_id`;
  const lastUsed = new Map(everUsed.map((r) => [r.prompt_id, r.last_used]));

  const fresh = prompts.filter((p) => !recentIds.has(p.seed.id));
  const pool = fresh.length > 0 ? fresh : prompts;
  pool.sort((a, b) => {
    const la = lastUsed.get(a.seed.id) ?? '';
    const lb = lastUsed.get(b.seed.id) ?? '';
    return la.localeCompare(lb) || a.seed.id.localeCompare(b.seed.id);
  });
  const chosen = pool[0]!;
  const fw = ctx.catalog.framework(pick.framework_id)!;
  return {
    framework_id: pick.framework_id,
    prompt_id: chosen.seed.id,
    prompt_version: chosen.seed.version,
    framework_version: fw.config.rubric_version,
    reason: pick.reason,
  };
}

/** Idempotently resolves the owned assignment for the learner's current local date. */
export async function getOrCreateAssignment(ctx: ServerContext, actor: Actor): Promise<{ assignment: AssignmentRow | null; localDay: string; timezone: string }> {
  const profile = await getProfile(ctx, actor.userId);
  const tz = profile.timezone;
  const localDay = localDate(ctx.now(), tz);
  const existing = await ctx.sql<AssignmentRow[]>`
    select id, user_id, local_date::text as local_date, timezone_snapshot, framework_id, framework_version, prompt_id, prompt_version, reason
      from public.daily_assignments where user_id = ${actor.userId} and local_date = ${localDay}`;
  if (existing[0]) return { assignment: existing[0], localDay, timezone: tz };

  const selection = await selectAssignment(ctx, actor, localDay);
  if (!selection) return { assignment: null, localDay, timezone: tz };
  await ctx.sql`
    insert into public.daily_assignments (user_id, local_date, timezone_snapshot, framework_id, framework_version, prompt_id, prompt_version, reason)
    values (${actor.userId}, ${localDay}, ${tz}, ${selection.framework_id}, ${selection.framework_version}, ${selection.prompt_id}, ${selection.prompt_version}, ${selection.reason})
    on conflict (user_id, local_date) do nothing`;
  const rows = await ctx.sql<AssignmentRow[]>`
    select id, user_id, local_date::text as local_date, timezone_snapshot, framework_id, framework_version, prompt_id, prompt_version, reason
      from public.daily_assignments where user_id = ${actor.userId} and local_date = ${localDay}`;
  return { assignment: rows[0] ?? null, localDay, timezone: tz };
}

export async function todayResponse(ctx: ServerContext, actor: Actor): Promise<TodayResponse> {
  const { assignment, localDay, timezone } = await getOrCreateAssignment(ctx, actor);
  const allowance = await getAllowance(ctx, actor.userId);
  const viewer = { editor: actor.editor };

  const pending = await ctx.sql<{ session_id: string; attempt_id: string | null; stage: string | null }[]>`
    select s.id as session_id, a.id as attempt_id, a.stage
      from public.practice_sessions s
      left join lateral (
        select id, stage from public.attempts where session_id = s.id and deleted_at is null order by ordinal desc limit 1
      ) a on true
     where s.user_id = ${actor.userId} and s.status = 'active' and s.deleted_at is null
       ${assignment ? ctx.sql`and s.assignment_id = ${assignment.id}` : ctx.sql`and s.created_at::date = ${localDay}::date`}
     order by s.created_at desc limit 1`;
  const completed = await ctx.sql<{ session_id: string; attempt_id: string; evaluation_id: string | null }[]>`
    select pd.attempt_id, a.session_id, (select id from public.evaluations e where e.attempt_id = a.id and e.kind = 'attempt' order by created_at desc limit 1) as evaluation_id
      from public.practice_days pd join public.attempts a on a.id = pd.attempt_id
     where pd.user_id = ${actor.userId} and pd.local_day = ${localDay}`;
  const skills = await skillStateRows(ctx, actor.userId);
  const stateOf = new Map(skills.map((s) => [s.framework_id, s.state]));
  const nextUnits = ctx.catalog
    .visibleFrameworks(viewer)
    .map((f) => ({ framework_id: f.config.id, app_title: f.config.app_title, state: stateOf.get(f.config.id) ?? ('new' as const) }))
    .slice(0, 10);

  let assignmentDto: TodayResponse['assignment'] = null;
  if (assignment) {
    const fw = ctx.catalog.framework(assignment.framework_id);
    const prompt = ctx.catalog.promptsById.get(assignment.prompt_id);
    if (fw && prompt) {
      assignmentDto = {
        id: assignment.id,
        framework: {
          id: fw.config.id,
          framework_number: frameworkNumber(fw.config.id),
          app_title: fw.config.app_title,
          objective: fw.config.objective,
          rubric_version: fw.config.rubric_version,
        },
        prompt: ctx.catalog.promptDto(prompt),
        reason: assignment.reason,
      };
    }
  }
  return {
    local_date: localDay,
    timezone,
    content_state: assignmentDto ? 'ready' : 'no_published_prompt',
    assignment: assignmentDto,
    allowance,
    pending_session: pending[0]
      ? { session_id: pending[0].session_id, attempt_id: pending[0].attempt_id, stage: (pending[0].stage as AttemptStage | null) }
      : null,
    completed_today: completed[0] ? { session_id: completed[0].session_id, attempt_id: completed[0].attempt_id, evaluation_id: completed[0].evaluation_id } : null,
    streak_days: await computeStreak(ctx, actor.userId, localDay),
    next_units: nextUnits,
  };
}
