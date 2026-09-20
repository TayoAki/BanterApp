-- Server-managed email + password authentication (AUTH_MODE=password).
-- On a plain PostgreSQL (Railway) the migrate runner created the auth stub
-- first; these tables hold credentials and refresh sessions. Never applied to
-- a Supabase project in supabase mode (the server does not use them there).

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists auth.credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email_normalized text not null unique,
  password_hash text not null,
  password_algo text not null default 'scrypt',
  failed_attempts int not null default 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  password_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists auth.refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  family uuid not null,
  auth_time timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  revoked_at timestamptz,
  replaced_by uuid,
  user_agent text
);
create index if not exists refresh_tokens_user on auth.refresh_tokens (user_id);
create index if not exists refresh_tokens_expiry on auth.refresh_tokens (expires_at) where revoked_at is null;

create table if not exists auth.login_attempts (
  id bigserial primary key,
  email_normalized text not null,
  ip text,
  success boolean not null,
  at timestamptz not null default now()
);
create index if not exists login_attempts_recent on auth.login_attempts (email_normalized, at);
create index if not exists login_attempts_ip on auth.login_attempts (ip, at);

-- Client roles never touch these tables.
revoke all on all tables in schema auth from anon, authenticated;
