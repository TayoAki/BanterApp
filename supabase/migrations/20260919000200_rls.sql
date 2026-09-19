-- Authorization: RLS on every table, default deny, explicit narrow grants.
-- Learners may read their own progress-related rows and published content
-- directly; every mutation and every job/result read goes through the API,
-- which uses a privileged connection behind explicit ownership checks.

-- Remove Supabase's permissive defaults for client roles.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- Content: published versions only, to everyone (guest sample lesson).
grant select on public.framework_versions, public.source_examples, public.prompt_versions, public.lesson_versions to anon, authenticated;
create policy content_published_frameworks on public.framework_versions for select using (publication_status = 'published');
create policy content_published_examples on public.source_examples for select using (publication_status = 'published');
create policy content_published_prompts on public.prompt_versions for select using (publication_status = 'published');
create policy content_published_lessons on public.lesson_versions for select using (publication_status = 'published');

-- Own profile (read; writes go through PATCH /preferences which validates fields).
grant select on public.profiles to authenticated;
create policy profiles_read_own on public.profiles for select to authenticated using (id = auth.uid() and account_state = 'active');

-- Own progress/attempt/evaluation reads (defense in depth; the app uses the API).
grant select on public.daily_assignments, public.practice_sessions, public.attempts, public.transcript_revisions,
  public.evaluations, public.rewrites, public.skill_progress, public.skill_evidence, public.completions, public.practice_days,
  public.quota_windows, public.entitlements to authenticated;
create policy own_daily_assignments on public.daily_assignments for select to authenticated using (user_id = auth.uid());
create policy own_sessions on public.practice_sessions for select to authenticated using (user_id = auth.uid() and deleted_at is null);
create policy own_attempts on public.attempts for select to authenticated using (user_id = auth.uid() and deleted_at is null);
create policy own_transcripts on public.transcript_revisions for select to authenticated
  using (user_id = auth.uid() and exists (select 1 from public.attempts a where a.id = attempt_id and a.deleted_at is null));
create policy own_evaluations on public.evaluations for select to authenticated
  using (user_id = auth.uid() and exists (select 1 from public.attempts a where a.id = attempt_id and a.deleted_at is null));
create policy own_rewrites on public.rewrites for select to authenticated
  using (user_id = auth.uid() and exists (select 1 from public.attempts a where a.id = attempt_id and a.deleted_at is null));
create policy own_skill_progress on public.skill_progress for select to authenticated using (user_id = auth.uid());
create policy own_skill_evidence on public.skill_evidence for select to authenticated using (user_id = auth.uid());
create policy own_completions on public.completions for select to authenticated using (user_id = auth.uid());
create policy own_practice_days on public.practice_days for select to authenticated using (user_id = auth.uid());
create policy own_quota on public.quota_windows for select to authenticated using (user_id = auth.uid());
create policy own_entitlements on public.entitlements for select to authenticated using (user_id = auth.uid());

-- No client grants at all: jobs, audio_assets, reservations, billing_events,
-- reports, deletion_jobs, telemetry_events, schema_migrations, functions.

-- Private storage bucket (Supabase only). Objects are reachable solely through
-- server-issued signed URLs; no storage.objects policies for client roles.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('practice-audio', 'practice-audio', false, 10485760,
            array['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/mpeg'])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  end if;
end $$;
