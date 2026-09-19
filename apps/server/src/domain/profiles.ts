import type { PreferencesDto } from '@marshmemos/contracts';
import { z } from 'zod';
import type { Actor, ServerContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import { isValidTimeZone } from '../time.js';

export interface ProfileRow {
  id: string;
  locale: string | null;
  timezone: string;
  goal: string | null;
  experience: string | null;
  social_context: string | null;
  reminder_enabled: boolean;
  reminder_time: string | null;
  onboarding_completed: boolean;
  deletion_generation: number;
  account_state: 'active' | 'deleting' | 'deleted';
  role: 'learner' | 'editor';
}

/**
 * Loads (creating on first use) the profile for a verified identity and
 * turns it into the request actor. Deleting/deleted accounts are refused.
 */
export async function loadActor(ctx: ServerContext, identity: { userId: string; email: string | null; authTime: number | null }): Promise<Actor> {
  const rows = await ctx.sql<ProfileRow[]>`select * from public.profiles where id = ${identity.userId}`;
  let profile = rows[0];
  if (!profile) {
    // Local/plain Postgres needs the auth.users row too; Supabase already has it.
    await ctx.sql`insert into auth.users (id, email) values (${identity.userId}, ${identity.email}) on conflict (id) do nothing`;
    const inserted = await ctx.sql<ProfileRow[]>`
      insert into public.profiles (id) values (${identity.userId})
      on conflict (id) do nothing
      returning *`;
    profile = inserted[0] ?? (await ctx.sql<ProfileRow[]>`select * from public.profiles where id = ${identity.userId}`)[0];
  }
  if (!profile) throw ApiError.unavailable('Profile could not be loaded.');
  if (profile.account_state !== 'active') throw new ApiError(403, 'account_deleting', 'This account is being deleted.');
  return {
    userId: profile.id,
    email: identity.email,
    editor: profile.role === 'editor',
    deletionGeneration: profile.deletion_generation,
    authTime: identity.authTime,
  };
}

export async function getProfile(ctx: ServerContext, userId: string): Promise<ProfileRow> {
  const rows = await ctx.sql<ProfileRow[]>`select * from public.profiles where id = ${userId}`;
  if (!rows[0]) throw ApiError.notFound('Profile not found.');
  return rows[0];
}

export function preferencesDto(p: ProfileRow): PreferencesDto {
  return {
    goal: p.goal,
    timezone: p.timezone,
    reminder_enabled: p.reminder_enabled,
    reminder_time: p.reminder_time ? p.reminder_time.slice(0, 5) : null,
    locale: p.locale,
    onboarding_completed: p.onboarding_completed,
  };
}

const GOALS = ['everyday_conversation', 'dating', 'work_social', 'general_confidence'] as const;
const EXPERIENCE = ['new', 'some', 'comfortable'] as const;

export const preferencesPatchSchema = z
  .object({
    goal: z.enum(GOALS).nullable().optional(),
    experience: z.enum(EXPERIENCE).nullable().optional(),
    social_context: z.string().max(200).nullable().optional(),
    timezone: z.string().min(1).max(64).optional(),
    locale: z.string().min(2).max(16).nullable().optional(),
    reminder_enabled: z.boolean().optional(),
    reminder_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().optional(),
    onboarding_completed: z.literal(true).optional(),
  })
  .strict();

export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

/**
 * PATCH /preferences: permitted fields only. Scores, roles, account state,
 * quota, publication and entitlement fields cannot be touched here.
 */
export async function updatePreferences(ctx: ServerContext, actor: Actor, patch: PreferencesPatch): Promise<PreferencesDto> {
  if (patch.timezone !== undefined) {
    if (!isValidTimeZone(patch.timezone)) throw ApiError.validation('Unknown timezone.');
    const ok = await ctx.sql<{ record_timezone_change: boolean }[]>`
      select public.record_timezone_change(${actor.userId}, ${patch.timezone}, ${ctx.config.MAX_TIMEZONE_CHANGES_PER_DAY})`;
    if (!ok[0]?.record_timezone_change) {
      throw ApiError.rateLimited('Timezone was changed too many times today. The new timezone applies tomorrow.');
    }
  }
  const sets: Record<string, unknown> = {};
  if (patch.goal !== undefined) sets['goal'] = patch.goal;
  if (patch.experience !== undefined) sets['experience'] = patch.experience;
  if (patch.social_context !== undefined) sets['social_context'] = patch.social_context;
  if (patch.locale !== undefined) sets['locale'] = patch.locale;
  if (patch.reminder_enabled !== undefined) sets['reminder_enabled'] = patch.reminder_enabled;
  if (patch.reminder_time !== undefined) sets['reminder_time'] = patch.reminder_time;
  if (patch.onboarding_completed !== undefined) sets['onboarding_completed'] = true;
  if (patch.reminder_enabled === false) sets['reminder_time'] = patch.reminder_time ?? null;
  if (Object.keys(sets).length > 0) {
    sets['updated_at'] = new Date();
    await ctx.sql`update public.profiles set ${ctx.sql(sets)} where id = ${actor.userId}`;
  }
  return preferencesDto(await getProfile(ctx, actor.userId));
}
