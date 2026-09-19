# marshmemos

Adult English-language banter practice. A learner reads one of ten small frameworks, speaks to a daily
prompt, confirms the transcript, gets criterion-specific feedback on those exact words, reads a
fact-preserving rewrite, hears it in an AI voice, and records a guided retry. Built from the handoff in
`handoff/` (product, engine, data, design, verification specs).

## Status

See `PLAN.md` for per-feature status and evidence. In short: the contracts engine, content package,
database schema, API, worker, provider adapters and the full mobile app are implemented and typecheck;
the offline and database-backed test suites pass; both native Hermes bundles export. Not yet done:
physical-device runs, live provider calls, store sandbox purchases, and Supabase project provisioning,
each of which needs owner-held credentials or devices (listed in `PLAN.md`).

## Repository

- `apps/mobile` Expo SDK 57 app (development build required: expo-audio, notifications, purchases)
- `apps/server` Hono API + durable Postgres-queue worker, OpenAI and RevenueCat adapters, fixture adapters for dev/test
- `packages/contracts` shared schemas/validators/totals/DTOs
- `packages/content` reviewed content loader and publication manifests
- `supabase/migrations` schema, functions, RLS
- `tests` cross-cutting checks
- `handoff` the original specification packet (do not edit)

## Quick start (local, no provider credentials)

```bash
pnpm install
# Postgres 15+ (Supabase local stack or plain Postgres)
export DATABASE_URL=postgres://postgres@127.0.0.1:5432/marshmemos
cat > apps/server/.env <<'ENV'
APP_ENV=development
DATABASE_URL=postgres://postgres@127.0.0.1:5432/marshmemos
AUTH_MODE=fixture
STORAGE_MODE=local
LOCAL_STORAGE_DIR=/tmp/marshmemos-storage
PROVIDER_MODE=fixture
CONTENT_MANIFEST=development
PUBLIC_API_BASE_URL=http://<your-lan-ip>:8787
ENV
pnpm server:api        # applies migrations, seeds content versions, serves /v1 on :8787
pnpm server:worker     # in another terminal
# apps/mobile/.env: EXPO_PUBLIC_API_BASE_URL=http://<your-lan-ip>:8787 (leave Supabase vars empty for development sign-in)
cd apps/mobile && npx expo run:ios   # or run:android; then `pnpm mobile`
```

With real services: set `AUTH_MODE=supabase`, `STORAGE_MODE=supabase`, `PROVIDER_MODE=openai`,
`CONTENT_MANIFEST=production` plus the secrets named in `.env.example`, apply
`supabase/migrations` to the project, and configure RevenueCat per `handoff/docs/08-service-setup.md`.

## Tests

```bash
pnpm typecheck
pnpm test                                        # contracts, content, server unit, mobile logic, cross-cutting
TEST_DATABASE_URL=postgres://... pnpm test:db     # schema, RLS, quota, jobs, end-to-end API journey with fixture providers
pnpm content:validate
python3 handoff/scripts/validate_handoff.py
```
