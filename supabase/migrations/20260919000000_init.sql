-- marshmemos core schema. UUID keys, UTC timestamps, versioned content,
-- non-null ownership on every private entity, composite ownership FKs.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  locale text,
  timezone text not null default 'UTC',
  timezone_changed_at timestamptz,
  timezone_change_count int not null default 0,
  timezone_change_window_start timestamptz,
  goal text,
  experience text,
  social_context text,
  reminder_enabled boolean not null default false,
  reminder_time time,
  onboarding_completed boolean not null default false,
  deletion_generation int not null default 0,
  account_state text not null default 'active' check (account_state in ('active', 'deleting', 'deleted')),
  role text not null default 'learner' check (role in ('learner', 'editor')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Versioned content (immutable after publish; server writes only)
-- ---------------------------------------------------------------------------
create table if not exists public.framework_versions (
  framework_id text not null,
  version text not null,
  framework_number int not null,
  curriculum_order int not null,
  app_title text not null,
  source_title text not null,
  source_file text not null,
  source_pdf_sha256 text not null,
  source_statement_verbatim text not null,
  source_statement_page int not null,
  objective text not null,
  criteria jsonb not null,
  example_ids text[] not null,
  primary_example_id text not null,
  content_hash text not null,
  publication_status text not null check (publication_status in ('draft', 'published', 'retired')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (framework_id, version)
);

create table if not exists public.source_examples (
  example_id text not null,
  version int not null default 1,
  framework_id text not null,
  source_filename text not null,
  source_pages int[] not null,
  source_pdf_sha256 text not null,
  text_verbatim text not null,
  text_sha256 text not null,
  teaching_use text not null,
  editorial_note text not null,
  publication_status text not null check (publication_status in ('draft', 'published', 'retired')),
  created_at timestamptz not null default now(),
  primary key (example_id, version)
);

create table if not exists public.prompt_versions (
  prompt_id text not null,
  version int not null,
  framework_id text not null,
  framework_version text not null,
  kind text not null check (kind in ('personal_reflection', 'fictional_roleplay')),
  level int not null,
  prompt text not null,
  criterion_ids text[] not null,
  example_ids text[] not null,
  target_min_seconds int not null,
  target_max_seconds int not null,
  hard_limit_seconds int not null,
  publication_status text not null check (publication_status in ('draft', 'published', 'retired')),
  created_at timestamptz not null default now(),
  primary key (prompt_id, version),
  foreign key (framework_id, framework_version) references public.framework_versions (framework_id, version)
);

create table if not exists public.lesson_versions (
  lesson_id text not null,
  version int not null,
  framework_id text not null,
  framework_version text not null,
  stage text not null check (stage in ('notice', 'build', 'transfer')),
  title text not null,
  explanation text not null,
  primary_example_id text not null,
  prompt_id text not null,
  prompt_version int not null,
  notice_task text,
  recognition jsonb,
  recognition_key_status text,
  publication_status text not null check (publication_status in ('draft', 'published', 'retired')),
  created_at timestamptz not null default now(),
  primary key (lesson_id, version),
  foreign key (framework_id, framework_version) references public.framework_versions (framework_id, version),
  foreign key (prompt_id, prompt_version) references public.prompt_versions (prompt_id, version)
);

-- ---------------------------------------------------------------------------
-- Daily assignment and allowance
-- ---------------------------------------------------------------------------
create table if not exists public.daily_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  local_date date not null,
  timezone_snapshot text not null,
  framework_id text not null,
  framework_version text not null,
  prompt_id text not null,
  prompt_version int not null,
  reason text not null check (reason in ('review_due', 'next_unit', 'least_recent')),
  created_at timestamptz not null default now(),
  unique (user_id, local_date),
  unique (id, user_id),
  foreign key (prompt_id, prompt_version) references public.prompt_versions (prompt_id, version)
);

create table if not exists public.quota_windows (
  user_id uuid not null references public.profiles (id) on delete cascade,
  window_date date not null,
  allowed_sessions int not null check (allowed_sessions >= 0),
  reserved int not null default 0 check (reserved >= 0),
  committed int not null default 0 check (committed >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, window_date),
  check (reserved + committed <= allowed_sessions)
);

create table if not exists public.practice_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  assignment_id uuid,
  mode text not null check (mode in ('daily', 'lesson', 'review', 'mixed', 'roleplay')),
  framework_id text not null,
  framework_version text not null,
  prompt_id text not null,
  prompt_version int not null,
  lesson_id text,
  lesson_version int,
  status text not null default 'active' check (status in ('active', 'completed', 'released', 'expired', 'deleted')),
  quota_window_date date not null,
  client_key text not null,
  roleplay_state jsonb,
  deletion_generation int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  deleted_at timestamptz,
  unique (user_id, client_key),
  unique (id, user_id),
  foreign key (assignment_id, user_id) references public.daily_assignments (id, user_id),
  foreign key (prompt_id, prompt_version) references public.prompt_versions (prompt_id, version)
);
create index if not exists practice_sessions_user_created on public.practice_sessions (user_id, created_at desc);

create table if not exists public.reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  window_date date not null,
  session_id uuid not null unique,
  status text not null check (status in ('reserved', 'committed', 'released')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (user_id, window_date) references public.quota_windows (user_id, window_date),
  foreign key (session_id, user_id) references public.practice_sessions (id, user_id)
);
create index if not exists reservations_expiry on public.reservations (expires_at) where status = 'reserved';

-- ---------------------------------------------------------------------------
-- Attempts, transcripts, media
-- ---------------------------------------------------------------------------
create table if not exists public.attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  session_id uuid not null,
  ordinal int not null check (ordinal >= 1),
  retry_of uuid,
  input_mode text not null check (input_mode in ('voice', 'typed')),
  is_guided_retry boolean not null default false,
  current_revision int not null default 0,
  stage text not null default 'created' check (stage in ('created', 'uploading', 'uploaded', 'transcribing', 'transcript_review', 'evaluating', 'feedback', 'failed', 'deleted')),
  client_key text not null,
  recoverable_error jsonb,
  transcription_job_id uuid,
  evaluation_job_id uuid,
  deletion_generation int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (session_id, ordinal),
  unique (user_id, client_key),
  unique (id, user_id),
  foreign key (session_id, user_id) references public.practice_sessions (id, user_id),
  foreign key (retry_of, user_id) references public.attempts (id, user_id)
);
create index if not exists attempts_user_created on public.attempts (user_id, created_at desc);

create table if not exists public.transcript_revisions (
  attempt_id uuid not null,
  revision int not null check (revision >= 0),
  user_id uuid not null,
  raw_text text,
  confirmed_text text,
  confirmed_at timestamptz,
  edited boolean not null default false,
  audio_asset_id uuid,
  provider_meta jsonb,
  created_at timestamptz not null default now(),
  primary key (attempt_id, revision),
  foreign key (attempt_id, user_id) references public.attempts (id, user_id),
  check ((revision = 0 and confirmed_text is null) or (revision > 0 and confirmed_text is not null and confirmed_at is not null))
);

create table if not exists public.audio_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  attempt_id uuid not null,
  kind text not null check (kind in ('raw', 'tts')),
  bucket text not null,
  object_key text not null unique,
  state text not null check (state in ('pending_upload', 'uploaded', 'verified', 'rejected', 'ready', 'expired', 'deleted')),
  declared_mime text,
  declared_bytes bigint,
  verified_mime text,
  verified_bytes bigint,
  verified_duration_seconds numeric(8, 3),
  rewrite_id uuid,
  voice_id text,
  tts_model text,
  text_sha256 text,
  expires_at timestamptz,
  deleted_at timestamptz,
  storage_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (attempt_id, user_id) references public.attempts (id, user_id)
);
create index if not exists audio_assets_expiry on public.audio_assets (expires_at) where storage_deleted_at is null;
create index if not exists audio_assets_attempt on public.audio_assets (attempt_id);

-- ---------------------------------------------------------------------------
-- Results (validated structured output + server totals)
-- ---------------------------------------------------------------------------
create table if not exists public.evaluations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  attempt_id uuid not null,
  transcript_revision int not null,
  kind text not null default 'attempt' check (kind in ('attempt', 'rewrite_candidate', 'roleplay_session')),
  candidate_ordinal int not null default 0,
  config_version text not null,
  model_id text,
  prompt_template_version text,
  rubric_version text not null,
  framework_id text not null,
  result jsonb not null,
  totals jsonb not null,
  status text not null check (status in ('scored', 'insufficient_input', 'uncertain', 'needs_revision')),
  source_copy_flag jsonb,
  is_guided_retry boolean not null default false,
  provider_meta jsonb,
  created_at timestamptz not null default now(),
  unique (attempt_id, transcript_revision, config_version, kind, candidate_ordinal),
  unique (id, user_id),
  foreign key (attempt_id, user_id) references public.attempts (id, user_id),
  foreign key (attempt_id, transcript_revision) references public.transcript_revisions (attempt_id, revision)
);
create index if not exists evaluations_user_created on public.evaluations (user_id, created_at desc);

create table if not exists public.rewrites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  evaluation_id uuid not null,
  attempt_id uuid not null,
  transcript_revision int not null,
  config_version text not null,
  status text not null check (status in ('queued', 'generating', 'validating', 'ready', 'needs_detail', 'unavailable', 'rejected')),
  result jsonb,
  rewrite_text text,
  question_for_user text,
  fact_check_state text check (fact_check_state in ('pending', 'passed', 'failed', 'skipped')),
  verification jsonb,
  fact_signals jsonb,
  candidate_evaluation_id uuid,
  improvement_label text check (improvement_label in ('stronger_version', 'another_way')),
  generation_attempts int not null default 0,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (evaluation_id, config_version),
  unique (id, user_id),
  foreign key (evaluation_id, user_id) references public.evaluations (id, user_id),
  foreign key (attempt_id, user_id) references public.attempts (id, user_id),
  foreign key (candidate_evaluation_id, user_id) references public.evaluations (id, user_id)
);

alter table public.audio_assets
  add constraint audio_assets_rewrite_fk foreign key (rewrite_id, user_id) references public.rewrites (id, user_id);

-- ---------------------------------------------------------------------------
-- Progress (derivable from evidence; server writes only)
-- ---------------------------------------------------------------------------
create table if not exists public.skill_evidence (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  framework_id text not null,
  rubric_version text not null,
  attempt_id uuid not null,
  evaluation_id uuid not null,
  prompt_id text not null,
  guided boolean not null,
  qualifies boolean not null,
  source_copy boolean not null default false,
  displayed_total int,
  occurred_at timestamptz not null default now(),
  unique (attempt_id, rubric_version),
  foreign key (attempt_id, user_id) references public.attempts (id, user_id),
  foreign key (evaluation_id, user_id) references public.evaluations (id, user_id)
);
create index if not exists skill_evidence_user_fw on public.skill_evidence (user_id, framework_id, occurred_at);

create table if not exists public.skill_progress (
  user_id uuid not null references public.profiles (id) on delete cascade,
  framework_id text not null,
  state text not null check (state in ('new', 'developing', 'ready', 'review_due')),
  review_step int not null default 0,
  next_due_at timestamptz,
  last_practiced_at timestamptz,
  last_qualified_at timestamptz,
  qualifying_attempts int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, framework_id)
);
create index if not exists skill_progress_due on public.skill_progress (next_due_at);

create table if not exists public.completions (
  user_id uuid not null references public.profiles (id) on delete cascade,
  lesson_id text not null,
  lesson_version int not null,
  attempt_id uuid not null,
  local_day date not null,
  xp int not null,
  created_at timestamptz not null default now(),
  primary key (user_id, lesson_id, lesson_version),
  foreign key (attempt_id, user_id) references public.attempts (id, user_id)
);

create table if not exists public.practice_days (
  user_id uuid not null references public.profiles (id) on delete cascade,
  local_day date not null,
  attempt_id uuid not null,
  xp int not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, local_day),
  foreign key (attempt_id, user_id) references public.attempts (id, user_id)
);

-- ---------------------------------------------------------------------------
-- Durable jobs
-- ---------------------------------------------------------------------------
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  attempt_id uuid,
  session_id uuid,
  type text not null check (type in ('transcribe', 'evaluate', 'rewrite', 'speech', 'roleplay_turn', 'roleplay_evaluate', 'cleanup_assets', 'delete_attempt', 'delete_account', 'reconcile_entitlement')),
  transcript_revision int,
  generation int not null default 0,
  stage_key text not null unique,
  state text not null check (state in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  scheduled_at timestamptz not null default now(),
  lease_until timestamptz,
  worker_id text,
  attempts int not null default 0,
  max_attempts int not null default 2,
  checkpoint jsonb not null default '{}'::jsonb,
  payload jsonb not null default '{}'::jsonb,
  result_id uuid,
  result_kind text,
  error_code text,
  error_message text,
  error_retryable boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists jobs_ready on public.jobs (state, scheduled_at) where state in ('queued', 'running');
create index if not exists jobs_attempt on public.jobs (attempt_id) where attempt_id is not null;
create index if not exists jobs_user on public.jobs (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Billing
-- ---------------------------------------------------------------------------
create table if not exists public.entitlements (
  user_id uuid not null references public.profiles (id) on delete cascade,
  entitlement_key text not null default 'pro',
  provider text not null default 'revenuecat',
  provider_customer_id text,
  source_environment text check (source_environment in ('sandbox', 'production', 'demo')),
  state text not null check (state in ('none', 'pending', 'active', 'grace', 'expired', 'revoked')),
  product_id text,
  expires_at timestamptz,
  grace_until timestamptz,
  reconciled_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, entitlement_key)
);
create index if not exists entitlements_customer on public.entitlements (provider, provider_customer_id);

create table if not exists public.billing_events (
  provider text not null,
  environment text not null,
  event_id text not null,
  event_type text,
  app_user_id text,
  product_id text,
  event_timestamp timestamptz,
  payload_minimized jsonb,
  state text not null check (state in ('received', 'processed', 'ignored', 'failed')),
  processed_at timestamptz,
  retry_count int not null default 0,
  error text,
  received_at timestamptz not null default now(),
  primary key (provider, environment, event_id)
);

-- ---------------------------------------------------------------------------
-- Reports, deletion, telemetry
-- ---------------------------------------------------------------------------
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  evaluation_id uuid not null,
  reason text not null,
  share_evidence boolean not null,
  evidence_snapshot jsonb,
  state text not null default 'received' check (state in ('received', 'reviewing', 'resolved')),
  created_at timestamptz not null default now(),
  foreign key (evaluation_id, user_id) references public.evaluations (id, user_id)
);

create table if not exists public.deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  generation int not null,
  scope text not null check (scope in ('account', 'attempt')),
  attempt_id uuid,
  steps jsonb not null default '[]'::jsonb,
  state text not null default 'requested' check (state in ('requested', 'running', 'completed', 'failed')),
  retry_count int not null default 0,
  last_error text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.telemetry_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  user_id uuid,
  name text not null,
  properties jsonb not null default '{}'::jsonb,
  platform text,
  created_at timestamptz not null default now()
);

create table if not exists public.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
