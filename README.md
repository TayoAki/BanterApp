# marshmemos

Adult English-language banter practice. A learner reads one of ten small frameworks, speaks to a daily
prompt, confirms the transcript, gets criterion-specific feedback on those exact words, reads a
fact-preserving rewrite, hears it in an AI voice, and records a guided retry. Built from the handoff in
`handoff/` (product, engine, data, design, verification specs).

## Status

See `PLAN.md` for per-feature status and evidence. In short: the contracts engine, content package,
database schema, API, worker, provider adapters and the full mobile app are implemented and typecheck;
the offline and database-backed test suites pass; both native Hermes bundles export. The server is
deployed on Railway (Postgres + private bucket + `api` and `worker` services from `apps/server/Dockerfile`).
Not yet done: live model calls (the owner must add rotated OpenRouter and Gemini keys as Railway variables),
physical-device runs, and store sandbox purchases (listed with exact blockers in `PLAN.md`).

## Stack

| Concern | Choice |
|---|---|
| Accounts | Email + password served by the API (`AUTH_MODE=password`): scrypt hashes, HS256 access tokens, rotating refresh tokens, lockout. Supabase Auth remains selectable. |
| Database | PostgreSQL (Railway Postgres). Migrations in `supabase/migrations` run on any plain Postgres. |
| Audio storage | Any S3-compatible private bucket (Railway Buckets) via presigned single-object URLs. |
| Text models | OpenRouter (chat completions with strict JSON schema) for evaluation, rewrite, verifier, roleplay. OpenAI Responses API selectable. |
| Audio models | Gemini for transcription (`gemini-3.5-transcribe`) and speech (`gemini-3.1-flash-tts-preview`, PCM wrapped as WAV). OpenAI audio selectable. |
| Billing | RevenueCat (sandbox first), off until configured. |

## Repository

- `apps/mobile` Expo SDK 57 app (development build required: expo-audio, notifications, purchases)
- `apps/server` Hono API + durable Postgres-queue worker, adapters (OpenRouter/OpenAI text, Gemini/OpenAI audio, S3/Supabase/local storage, RevenueCat), fixture adapters for dev/test, `Dockerfile` for Railway
- `packages/contracts` shared schemas/validators/totals/DTOs
- `packages/content` reviewed content loader and publication manifests
- `supabase/migrations` schema, functions, RLS (applied by the server on start under an advisory lock)
- `tests` cross-cutting checks
- `handoff` the original specification packet (do not edit)

## Quick start (local, no provider credentials)

```bash
pnpm install
# Postgres 15+ (plain Postgres is fine)
cat > apps/server/.env <<'ENV'
APP_ENV=development
DATABASE_URL=postgres://postgres@127.0.0.1:5432/marshmemos
AUTH_MODE=password
AUTH_JWT_SECRET=<32+ random characters, local only>
STORAGE_MODE=local
LOCAL_STORAGE_DIR=/tmp/marshmemos-storage
PROVIDER_MODE=fixture
CONTENT_MANIFEST=development
PUBLIC_API_BASE_URL=http://<your-lan-ip>:8787
ENV
pnpm server:api        # applies migrations, seeds content versions, serves /v1 on :8787
pnpm server:worker     # in another terminal
# apps/mobile/.env: EXPO_PUBLIC_API_BASE_URL=http://<your-lan-ip>:8787 overrides the Railway URL in app.json for LAN development
cd apps/mobile && npx expo run:ios   # or run:android; then `pnpm mobile`
```

With live models locally: `PROVIDER_MODE=live`, `TEXT_AI_API_KEY=<OpenRouter key>`, `AUDIO_AI_API_KEY=<Gemini key>`
in `apps/server/.env` (never in the repo or a chat). Model IDs are configuration (`.env.example`).

## Railway

The Railway project `marshmemos` holds `Postgres`, the bucket `practice-audio`, and the services `api` and
`worker`, both built from `apps/server/Dockerfile` with the repository root as build context (the worker
overrides the start command with `node dist/worker.js`). Service variables reference
`${{Postgres.DATABASE_URL}}`, `${{practice-audio.*}}` and three shared secrets (`AUTH_JWT_SECRET`,
`TEXT_AI_API_KEY`, `AUDIO_AI_API_KEY`) that the owner creates once under Project Settings → Shared Variables.
The mobile app points at `https://api-production-092a.up.railway.app` through `app.json` `extra.apiBaseUrl`.
`docs/operations.md` has the runbook.

## Tests

```bash
pnpm typecheck
pnpm test                                        # contracts, content, server unit (incl. adapter request shaping), mobile logic, cross-cutting
TEST_DATABASE_URL=postgres://... pnpm test:db     # schema, RLS, quota, jobs, password accounts, end-to-end API journey with fixture providers
pnpm content:validate
python3 handoff/scripts/validate_handoff.py
docker build -f apps/server/Dockerfile .          # the Railway image
```
