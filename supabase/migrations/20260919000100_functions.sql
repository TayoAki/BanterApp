-- Server-side functions. Called only by the API/worker (service role / direct
-- connection); not exposed to client roles.

-- ---------------------------------------------------------------------------
-- Allowance reservation (atomic per UTC window)
-- ---------------------------------------------------------------------------
create or replace function public.reserve_session_allowance(
  p_user uuid,
  p_session uuid,
  p_window date,
  p_allowed int,
  p_ttl interval
) returns table (reservation_id uuid, allowed int, reserved int, committed int)
language plpgsql as $$
#variable_conflict use_column
declare
  w public.quota_windows%rowtype;
  r_id uuid;
begin
  insert into public.quota_windows (user_id, window_date, allowed_sessions)
  values (p_user, p_window, p_allowed)
  on conflict (user_id, window_date) do update
    set allowed_sessions = greatest(public.quota_windows.allowed_sessions, excluded.allowed_sessions),
        updated_at = now();

  select * into w from public.quota_windows
   where user_id = p_user and window_date = p_window for update;

  -- Idempotent: an existing live reservation for this session is returned.
  select id into r_id from public.reservations
   where session_id = p_session and status in ('reserved', 'committed');
  if r_id is not null then
    return query select r_id, w.allowed_sessions, w.reserved, w.committed;
    return;
  end if;

  if w.reserved + w.committed >= w.allowed_sessions then
    raise exception 'quota_exceeded' using errcode = 'P0001',
      detail = format('allowed=%s reserved=%s committed=%s', w.allowed_sessions, w.reserved, w.committed);
  end if;

  -- A reservation released after a system failure can be taken again when
  -- the learner resumes the same session (same logical allowance).
  select id into r_id from public.reservations where session_id = p_session and status = 'released';
  if r_id is not null then
    -- The session may resume in a later UTC window: move the reservation to
    -- the window whose counter is being incremented.
    update public.reservations set status = 'reserved', window_date = p_window, expires_at = now() + p_ttl, updated_at = now() where id = r_id;
    update public.practice_sessions set quota_window_date = p_window, updated_at = now() where id = p_session;
  else
    insert into public.reservations (user_id, window_date, session_id, status, expires_at)
    values (p_user, p_window, p_session, 'reserved', now() + p_ttl)
    returning id into r_id;
  end if;

  update public.quota_windows set reserved = reserved + 1, updated_at = now()
   where user_id = p_user and window_date = p_window;

  return query select r_id, w.allowed_sessions, w.reserved + 1, w.committed;
end $$;

create or replace function public.commit_session_allowance(p_session uuid) returns boolean
language plpgsql as $$
#variable_conflict use_column
declare
  r public.reservations%rowtype;
begin
  select * into r from public.reservations where session_id = p_session for update;
  if not found then return false; end if;
  if r.status = 'committed' then return true; end if;
  if r.status = 'released' then
    -- Work completed after a release (for example lease expiry reconciliation):
    -- re-take the slot if available so the learner keeps the completion.
    perform 1 from public.quota_windows where user_id = r.user_id and window_date = r.window_date for update;
    update public.quota_windows set committed = committed + 1, updated_at = now()
     where user_id = r.user_id and window_date = r.window_date and reserved + committed < allowed_sessions;
    if not found then
      -- Cap already full; keep the completion but do not exceed the cap.
      update public.reservations set status = 'committed', updated_at = now() where id = r.id;
      return true;
    end if;
    update public.reservations set status = 'committed', updated_at = now() where id = r.id;
    return true;
  end if;
  perform 1 from public.quota_windows where user_id = r.user_id and window_date = r.window_date for update;
  update public.quota_windows
     set reserved = greatest(reserved - 1, 0), committed = committed + 1, updated_at = now()
   where user_id = r.user_id and window_date = r.window_date;
  update public.reservations set status = 'committed', updated_at = now() where id = r.id;
  return true;
end $$;

create or replace function public.release_session_allowance(p_session uuid) returns boolean
language plpgsql as $$
#variable_conflict use_column
declare
  r public.reservations%rowtype;
begin
  select * into r from public.reservations where session_id = p_session for update;
  if not found then return false; end if;
  if r.status <> 'reserved' then return false; end if;
  perform 1 from public.quota_windows where user_id = r.user_id and window_date = r.window_date for update;
  update public.quota_windows set reserved = greatest(reserved - 1, 0), updated_at = now()
   where user_id = r.user_id and window_date = r.window_date;
  update public.reservations set status = 'released', updated_at = now() where id = r.id;
  return true;
end $$;

-- Expired reservations are released only when no job for that session is
-- still running or queued (reconciliation rule from docs/04).
create or replace function public.release_expired_reservations(p_limit int default 100) returns int
language plpgsql as $$
declare
  n int := 0;
  rec record;
begin
  for rec in
    select r.session_id from public.reservations r
     where r.status = 'reserved' and r.expires_at < now()
       and not exists (
         select 1 from public.jobs j
          where j.session_id = r.session_id and j.state in ('queued', 'running'))
     limit p_limit
  loop
    if public.release_session_allowance(rec.session_id) then
      update public.practice_sessions set status = 'expired', updated_at = now()
       where id = rec.session_id and status = 'active';
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Job queue
-- ---------------------------------------------------------------------------
create or replace function public.claim_jobs(p_worker text, p_lease interval, p_limit int default 5)
returns setof public.jobs
language plpgsql as $$
begin
  return query
  with candidates as (
    select id from public.jobs
     where (state = 'queued' and scheduled_at <= now())
        or (state = 'running' and lease_until is not null and lease_until < now() and attempts < max_attempts)
     order by scheduled_at
     limit p_limit
     for update skip locked
  )
  update public.jobs j
     set state = 'running',
         worker_id = p_worker,
         lease_until = now() + p_lease,
         attempts = j.attempts + 1,
         updated_at = now()
    from candidates c
   where j.id = c.id
   returning j.*;
end $$;

create or replace function public.renew_job_lease(p_job uuid, p_worker text, p_lease interval) returns boolean
language plpgsql as $$
begin
  update public.jobs set lease_until = now() + p_lease, updated_at = now()
   where id = p_job and worker_id = p_worker and state = 'running';
  return found;
end $$;

-- Commit only if the job still holds its lease.
create or replace function public.complete_job(
  p_job uuid, p_worker text, p_result_id uuid, p_result_kind text, p_checkpoint jsonb
) returns boolean
language plpgsql as $$
begin
  update public.jobs
     set state = 'succeeded', result_id = p_result_id, result_kind = p_result_kind,
         checkpoint = checkpoint || coalesce(p_checkpoint, '{}'::jsonb), finished_at = now(), updated_at = now(),
         lease_until = null
   where id = p_job and worker_id = p_worker and state = 'running';
  return found;
end $$;

create or replace function public.fail_job(
  p_job uuid, p_worker text, p_code text, p_message text, p_retryable boolean, p_backoff interval, p_checkpoint jsonb
) returns text
language plpgsql as $$
declare
  j public.jobs%rowtype;
begin
  select * into j from public.jobs where id = p_job for update;
  if not found or j.worker_id <> p_worker or j.state <> 'running' then return 'lost_lease'; end if;
  if p_retryable and j.attempts < j.max_attempts then
    update public.jobs
       set state = 'queued', scheduled_at = now() + p_backoff, lease_until = null, worker_id = null,
           error_code = p_code, error_message = p_message, error_retryable = true,
           checkpoint = checkpoint || coalesce(p_checkpoint, '{}'::jsonb), updated_at = now()
     where id = p_job;
    return 'requeued';
  end if;
  update public.jobs
     set state = 'failed', lease_until = null, error_code = p_code, error_message = p_message,
         error_retryable = p_retryable, checkpoint = checkpoint || coalesce(p_checkpoint, '{}'::jsonb),
         finished_at = now(), updated_at = now()
   where id = p_job;
  return 'failed';
end $$;

-- Sweeper: jobs whose lease expired and attempts are exhausted become failed.
create or replace function public.sweep_exhausted_jobs() returns int
language plpgsql as $$
declare n int;
begin
  update public.jobs
     set state = 'failed', error_code = coalesce(error_code, 'lease_expired'),
         error_message = coalesce(error_message, 'Worker lease expired and retries are exhausted.'),
         error_retryable = false, finished_at = now(), updated_at = now(), lease_until = null
   where state = 'running' and lease_until < now() and attempts >= max_attempts;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.cancel_jobs_for_attempt(p_attempt uuid, p_reason text) returns int
language plpgsql as $$
declare n int;
begin
  update public.jobs
     set state = 'canceled', error_code = p_reason, finished_at = now(), updated_at = now(), lease_until = null
   where attempt_id = p_attempt and state in ('queued', 'running');
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Timezone abuse guard: at most N timezone changes per rolling 24h
-- ---------------------------------------------------------------------------
create or replace function public.record_timezone_change(p_user uuid, p_tz text, p_max int) returns boolean
language plpgsql as $$
declare p public.profiles%rowtype;
begin
  select * into p from public.profiles where id = p_user for update;
  if not found then return false; end if;
  if p.timezone = p_tz then return true; end if;
  if p.timezone_change_window_start is null or p.timezone_change_window_start < now() - interval '24 hours' then
    update public.profiles set timezone = p_tz, timezone_changed_at = now(), timezone_change_count = 1,
           timezone_change_window_start = now(), updated_at = now() where id = p_user;
    return true;
  end if;
  if p.timezone_change_count >= p_max then
    return false;
  end if;
  update public.profiles set timezone = p_tz, timezone_changed_at = now(),
         timezone_change_count = timezone_change_count + 1, updated_at = now() where id = p_user;
  return true;
end $$;

-- Increment deletion generation; everything committed against the old
-- generation becomes inaccessible.
create or replace function public.bump_deletion_generation(p_user uuid, p_state text) returns int
language plpgsql as $$
declare g int;
begin
  update public.profiles
     set deletion_generation = deletion_generation + 1, account_state = p_state, updated_at = now()
   where id = p_user
   returning deletion_generation into g;
  return g;
end $$;
