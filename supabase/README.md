# Supabase setup

Migrations in `migrations/` are plain SQL applied in filename order. They assume Supabase's
`auth` schema and the `anon`/`authenticated`/`service_role` roles exist (they do on any project).
`local/auth_stub.sql` is only for plain PostgreSQL (tests, local dev) and is applied automatically by
`apps/server/src/db/migrate.ts` when `auth.users` is missing; never apply it to a Supabase project.

## Apply

Either run the server once (`pnpm server:api` applies pending migrations and seeds content versions), or:

```bash
supabase link --project-ref <ref>
supabase db push          # applies supabase/migrations
```

## What the migrations set up

- Tables from `handoff/docs/04-data-and-api.md` with composite `(id, user_id)` ownership keys.
- Functions: `reserve_session_allowance`, `commit_session_allowance`, `release_session_allowance`,
  `release_expired_reservations`, `claim_jobs` (FOR UPDATE SKIP LOCKED), `renew_job_lease`, `complete_job`,
  `fail_job`, `sweep_exhausted_jobs`, `cancel_jobs_for_attempt`, `record_timezone_change`,
  `bump_deletion_generation`. All are called only by the server; client roles have no EXECUTE grant.
- RLS forced on every table: learners read their own rows and published content; no client writes; jobs,
  media, reservations, billing, reports, deletion and telemetry tables have no client grants at all.
- Private bucket `practice-audio` (10 MiB, audio MIME allowlist) with no client storage policies; access is
  only through server-issued signed URLs.

## Auth

Email one-time codes (`signInWithOtp` + `verifyOtp` type `email`). The server verifies access tokens with the
project JWKS (`/auth/v1/.well-known/jwks.json`); set `SUPABASE_JWT_SECRET` only for legacy HS256 projects.
Account deletion calls `auth.admin.deleteUser` with the service role after cleanup.
