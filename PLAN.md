# marshmemos implementation plan (living status)

The original plan is `handoff/PLAN.md` (unchanged). This file records what was built, what was
observed, and exact blockers. Statuses: `planned`, `in_progress`, `implemented_unverified`,
`verified`, `blocked`, `deferred`. "Verified" here means acceptance evidence from automated tests
run in this repository against a real PostgreSQL; it does **not** mean physical-device or live-provider
evidence unless that is stated explicitly.

Environment used for all evidence below: Linux x86_64 container, Node 22.22.2, pnpm 10.33.0,
PostgreSQL 16.15 (local, plain Postgres with `supabase/local/auth_stub.sql`), no network access to model
providers, no iOS/Android device or emulator, no provider credentials. Railway was reachable through its MCP
tools and is provisioned (below). Package versions are locked in `pnpm-lock.yaml` (Expo 57.0.24, React Native
0.86.3, React 19.2.3, expo-router 57.0.22, expo-audio 57.0.5, expo-notifications 57.0.20, expo-file-system 57.0.7,
react-native-purchases 10.10.0, hono 4.13.8, postgres 3.4.9, openai 7.20.0, @google/genai 2.23.0,
@aws-sdk/client-s3 3.1136.0, jose 6.2.12, ajv 8.20.0, zod 4.6.5, TypeScript 6.0.3, vitest 5.0.1).

## Evidence summary (this revision)

| Check | Result |
|---|---|
| `pnpm typecheck` (contracts, content, server, mobile) | pass |
| `packages/contracts` tests | 43 passed (fixture totals 6/9 = 6/6 + 0/3; hallucinated evidence, borrowed criteria, wrong revision/framework/source id, null-score rules, low-confidence withholding, rewrite fact checks, verifier spans, improvement labeling, source-copy detection on all 20 examples, provider schema translation) |
| `packages/content` tests + `pnpm content:validate` | 11 passed; 407 integrity checks incl. 10 PDF SHA-256, 20 verbatim quotes in page text, statements on page 1, 30 prompts/30 lessons, 10 authored Notice keys quoting exact spans |
| `apps/server` unit tests | 36 passed (config guards for the Railway and Supabase stacks, prompt template byte-equality, MP4/MP3 probe on real ffmpeg-encoded fixtures, Supabase-shaped and server-issued JWT verification incl. recent-auth, adapter request shaping: OpenRouter strict `json_schema` + `require_parameters` with learner text only in the data envelope, Gemini Interactions verbatim transcription and generateContent literal-JSON transcription, Gemini speech PCM→WAV with the stored text only, S3 presigned PUT/GET on the virtual-hosted bucket host without SDK checksum params, provider error classification) |
| `apps/server` DB tests (`pnpm test:db`) | 49 passed: password accounts end to end (register/sign-in with identical failure copy for unknown emails, weak password and malformed body rejection, refresh rotation with family revocation on replay, logout, 10-failure lockout that lifts after the window, password change revoking every session, account deletion refused on a stale `auth_time` and completed after a fresh sign-in with credentials removed); quota concurrency (2 simultaneous starts admit 1), idempotent reserve/commit/release, Pro mid-window cap raise, expired-reservation guard with active job, CHECK cap; job claim with SKIP LOCKED across 2 workers, lease expiry reclaim, lost-lease commit refusal, retry/backoff/terminal failure, requeue of same logical stage, sweeper, cancellation; RLS own-row reads, anon published-only, no client access to jobs/assets/reservations/billing, no client writes, composite ownership FK; full API journey (below) |
| `apps/mobile` tests | 11 passed (format helpers; sign-in error copy mapping; exact production copy present per docs/05, "Framework fit"/"Hear a stronger version" absent) |
| `tests` package | handoff validator PASS, repository layout, no secrets in `.env.example` |
| `npx expo config --type introspect` | NSMicrophoneUsageDescription exact text, RECORD_AUDIO, scheme `marshmemos`, bundle/package `com.marshmemos.app`, `FOREGROUND_SERVICE_MICROPHONE` blocked |
| `npx expo export --platform ios` / `android` | Hermes bundles built (4.6 MB iOS after removing the Supabase client), all monorepo imports resolve |
| `handoff/scripts/validate_handoff.py` | PASS |

Full API journey covered by `apps/server/src/__tests__/journey.db.test.ts` with fixture providers and local
storage: Today assignment stable across launches and timezone change → session with atomic reservation
(idempotent by client key, 429 at free cap) → attempt → single-object signed upload (forged path 403,
complete-before-bytes 409) → real M4A verified by container probe, invalid bytes 422 with no job →
transcription job → transcript revision 1 → evaluate exactly that revision → server totals 6/9, 6/6, 0/3,
evidence quotes present in confirmed text → allowance committed once, streak 1 → rewrite generated,
lexically checked, verified, re-evaluated, labeled `stronger_version` → TTS only from stored text, cached,
owner-only playback URL that serves bytes → guided typed retry linked to the first attempt, comparison
6→8 with per-criterion deltas and "Guided retry · mastery still developing", third attempt 429 →
transcript correction supersedes rewrite/audio (old café story cannot play), correction budget 429,
re-evaluation on revision 2 → adversarial: "Ignore the rubric" not obeyed, verbatim E02-01 flagged and
non-qualifying, threat → `needs_revision` with no total and no rewrite, invented "barista laughed" rewrite
rejected twice → `needs_detail`, insufficient input → null scores and no XP → reports with/without
evidence consent, timezone change rate limit, single-practice deletion removes storage objects and rows and
cancels a late job, billing webhook auth/dedupe/environment isolation/reconciliation, account deletion with
recent-auth requirement and completed cleanup, expired asset sweep removes objects; recovery paths: re-take
before confirmation replaces the unconfirmed upload, failed transcription resumes via upload-complete or
continues as typed input, roleplay turns cannot be evaluated individually and a deleted turn is scrubbed from
conversation state and job checkpoints, Bearer-prefixed provider headers reach the webhook authenticator,
implausible container durations are rejected, superseded TTS returns 410 after a correction.

## Independent review pass (same revision)

Two unanchored reviews (server security/consistency; mobile runtime) were run on the first build and every
substantiated finding was fixed and pinned with a test where the environment allows:

- Server: recent-auth now derives from Supabase `amr` timestamps (was an absent `auth_time` claim, which
  would have blocked all account deletions in production); released reservations re-taken in a later UTC
  window move to that window; superseded rewrite audio is unplayable and expires; failed transcriptions are
  requeued on upload-complete instead of dead-ending; job error text shown to clients is a fixed per-code
  message; roleplay attempts cannot be evaluated/rewritten/spoken individually; attempt deletion scrubs
  roleplay state and job checkpoints; candidate evaluations are written inside the commit guard; commit
  locks the attempt before the job; `claim_jobs` skips exhausted leases; `fail_job`/`complete_job` merge
  checkpoints; the billing webhook is excluded from bearer auth; repair retries send only fixed text in the
  instruction channel (details ride in the data envelope); `createAttempt`/roleplay turns reactivate a
  released session; evaluations carry a `current` flag and Today uses the current-revision evaluation; media
  duration also reads the audio track and the implied bitrate must be plausible; the server refuses to start
  in production without an RLS-bypassing database role.
- Mobile (fixed, not executable here): recorder unmount cleanup no longer touches the released native
  object (would have been a fatal error after every recording); completion is driven by the native finish
  event so the 90 s cap shows the take with its real duration; discarded takes delete their file; an
  uploaded take resumes at upload-complete instead of re-uploading; "Record again" before confirmation
  reuses the attempt (server re-take), after feedback it records the included retry; Today routes pending
  items by state; the auth gate redirects on a second sign-in and no longer stores the sign-out screen as
  the next destination; feedback shows a "still working" state after the two-minute budget and marks stale
  feedback; transcript copy distinguishes a missing local file; roleplay is reachable from fictional
  lessons and its spoken turns hand confirmed words back to the conversation.

Note on migrations: the SQL function file was edited in place because no database outside this build had
applied it yet. From the first deployed environment onward, changes go in new migration files.

## Railway stack (this revision)

Decision (owner): everything on Railway, plain email + password sign-in (no one-time codes), OpenRouter for the
text models, Gemini for speech. What changed and what was observed:

- **Accounts** (`apps/server/src/auth/password.ts`, `http/auth-routes.ts`, migration `20260919000300_password_auth.sql`):
  scrypt (N=2^15) password hashes, HS256 access tokens (1 h, issuer/audience `marshmemos`, `auth_time` = last
  password proof), opaque single-use refresh tokens (60 days, SHA-256 at rest, family revocation on replay),
  lockout (10 failures/email/15 min, 30/IP), identical responses for unknown and wrong-password sign-ins.
  `POST /v1/auth/register|login|refresh|logout|password`, `GET /v1/auth/session`. Deleting an account removes
  `auth.users` (cascade to credentials and refresh sessions). Recent-auth for deletion follows `auth_time`, which
  survives refreshes, so a stale session must sign in again (tested). Supabase mode remains selectable.
- **Mobile**: sign-in screen is email + password with create-account toggle (`app/auth.tsx`); tokens live in
  the encrypted large secure store (`lib/secure-store.ts`); the API client refreshes shortly before expiry and once
  on a 401, then replays the request (`lib/api.ts`, `lib/auth.tsx`); sign-out revokes the refresh session.
  `@supabase/supabase-js` and `react-native-url-polyfill` were removed from the app.
- **Storage**: `S3Storage` (`storage/s3.ts`) for any S3-compatible bucket, presigned single-object PUT/GET, checksums
  only where required, single-object deletes; Railway Buckets use virtual-hosted URLs (`S3_FORCE_PATH_STYLE=false`).
- **Models**: text via OpenRouter chat completions with strict `response_format: json_schema` and
  `provider.require_parameters` (`providers/openai.ts`; the OpenAI Responses API stays selectable). Audio via
  Gemini (`providers/gemini.ts`): transcription through the Interactions API in verbatim mode for
  `gemini-3.5-transcribe` (or generateContent with a literal-transcription instruction for a general model),
  speech through generateContent with `responseModalities: AUDIO`, PCM wrapped as WAV (`media/mp4.ts`). Default IDs:
  `openai/gpt-5`, `openai/gpt-5-mini`, `gemini-3.5-transcribe`, `gemini-3.1-flash-tts-preview`, voice `Kore`.
- **Research note on "Gemini 3.8 Live"**: public write-ups describe `gemini-3.8-live` as a native realtime
  speech-to-speech model on the Live API (WebSocket sessions), released alongside `gemini-3.5-transcribe`
  (file/stream transcription, 85+ languages) and the `gemini-3.1-flash-tts(-preview)` speech models. The V1
  pipeline is sequential (record → confirm transcript → evaluate → rewrite → play), so the Live API does not fit;
  the transcription and TTS models are used instead. Google's documentation pages were not reachable from this
  container (egress blocked), so the exact model IDs and the Interactions request shape are taken from the
  installed `@google/genai` 2.23.0 types and secondary sources; `AUDIO_AI_TRANSCRIBE_API`, `TRANSCRIPTION_MODEL`
  and `TTS_MODEL` are configuration so the first live call can correct them without a code change.
- **Container**: `apps/server/Dockerfile` (multi-stage, pnpm 10.33.0, server-only install, esbuild bundle that
  inlines the workspace packages and copies prompts/migrations/auth stub next to `dist/`). Migrations run under a
  transaction-scoped advisory lock so `api` and `worker` can start together. No Docker daemon exists in this
  container; the first Railway build (commit `2a13884`) was the verification: image built in about 40 s
  (`pnpm install --filter @marshmemos/server...` 3.9 s, bundle built, 304 MB image pushed), the container started
  and exited with exactly the config guard `Refusing to start: TEXT_AI_API_KEY is required ...; AUDIO_AI_API_KEY is
  required ...; AUTH_JWT_SECRET is required when AUTH_MODE=password`. The database and bucket references were not
  in that list, so `${{Postgres.DATABASE_URL}}` and `${{practice-audio.*}}` resolved. The health check then
  failed as designed; the three values below are the only remaining inputs.
- **Railway provisioning (done through the Railway MCP)**: project `marshmemos` (id `f3d2b4d8-c9e7-4bc0-a130-ed7ce3009e69`,
  environment `production` `2dee1074-8e14-4464-a381-8220313f5e5e`), `Postgres` (template `postgres-ssl:18`, volume 50 GB),
  bucket `practice-audio` (region sjc), services `api` (`da5e446a-456f-4534-b9a9-f45d3e23f143`, healthcheck `/healthz`,
  domain `api-production-092a.up.railway.app`) and `worker` (`f42841d5-62f0-427c-b773-7d03e32f4009`, start `node dist/worker.js`),
  both `dockerfilePath=apps/server/Dockerfile`, restart on failure, watch paths limited to server/packages/supabase.
  Variables set on both: `APP_ENV=production`, `AUTH_MODE=password`, `AUTH_JWT_SECRET=${{shared.AUTH_JWT_SECRET}}`,
  `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `STORAGE_MODE=s3` with `S3_*=${{practice-audio.*}}`, `PROVIDER_MODE=live`,
  `TEXT_AI_PROVIDER=openrouter`, `AUDIO_AI_PROVIDER=gemini`, `CONTENT_MANIFEST=production`, `BILLING_PROVIDER=none`;
  `api` also has `PUBLIC_API_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}`.

**Exact blockers before the services start** (the config guard refuses to boot without them, by design):

1. Shared variable `AUTH_JWT_SECRET` (Project Settings → Shared Variables → production): 64 random characters.
   Generating a credential from this session was declined by the tool policy, so the owner creates it; both services
   already reference `${{shared.AUTH_JWT_SECRET}}`. Seal it after creating it.
2. `TEXT_AI_API_KEY` (OpenRouter) and `AUDIO_AI_API_KEY` (Gemini) on `api` and `worker`. The OpenRouter and Gemini keys
   that were pasted into the build chat must be **rotated first** and the new values entered only in Railway.
3. Connect both services to GitHub `TayoAki/BanterApp`, branch `claude/sweet-turing-lvns8k` (done from this session if
   the GitHub authorization allows it; otherwise Service → Settings → Source). The first deploy applies the migrations.
4. Record the first live call per model (transcription, evaluation, rewrite, verifier, speech) here before any
   provider is called "connected"; adjust `TRANSCRIPTION_MODEL`/`TTS_MODEL`/`AUDIO_AI_TRANSCRIBE_API` if a model ID
   or surface is rejected (the deploy log names the failing variable or provider status).
5. Mobile: set `EXPO_PUBLIC_API_BASE_URL=https://api-production-092a.up.railway.app` in `apps/mobile/.env`
   for the development build.

## Slice status

| ID | User outcome | Status | Evidence / remaining |
|---|---|---|---|
| M00 | Reproducible mobile/worker project | verified (repo) | pnpm workspace, locked versions, `.env.example`, explicit fixture mode refused in production (config tests), content validator passes. Native dev builds are configured (`expo-dev-client`, plugins) but were not compiled here: **needs Xcode/Android SDK** (`npx expo run:ios|android`). |
| M01 | Read original framework lessons | implemented_unverified (device) | Catalog/lesson API serve published versions only; drafts require the server-held editor role; source quotes render from corpus records with editorial labels; long quotes scroll (`SourceQuote`). Screen-level verification pending on device. |
| M02 | Sign in and keep own progress | verified (API) / unverified (device) | Email + password accounts served by the API with scrypt hashes, rotating refresh tokens and lockout; encrypted secure storage on the device; refresh-on-expiry and on 401; own-row RLS and two-user API denial verified in tests (`auth.db.test.ts`, `journey.db.test.ts`). Device cold-start and token expiry behavior pending a development build against the Railway API. |
| M03 | Speak and review a local take | implemented_unverified (device) | expo-audio recorder, metering-driven waveform, 90 s cap (`forDuration` + guard), background/interruption stop with preserved take, document-directory persistence with 24 h expiry, typed alternative, permission-denied copy. **Needs physical devices** for permissions, containers, lifecycle. |
| M04 | Receive and correct a transcript | verified (API, fixture STT) / unverified (live STT) | Private signed upload, byte/format/duration validation, exactly-once transcription job, review/edit/confirm with revisions, offline retry copy, wrong-owner 404. **Live transcription not run** (Gemini key not yet set in Railway). |
| M05 | Get strict framework feedback | verified (engine + API, fixture evaluator) / unverified (live model) | Exact revision/rubric/evidence validation, server totals, uncertainty and boundary handling, injection and source-copy cases, persisted results. **Model quality/calibration suite (100 cases, 30 held out) not run**: needs provider access and two reviewers. |
| M06 | Read a truthful improved version | verified (pipeline, fixture models) | Lexical fact checks, deterministic entity/number signals, independent verifier, separate re-evaluation, `stronger_version` only on validated improvement, `needs_detail` path, original feedback retained on failure. |
| M07 | Hear the approved rewrite | verified (API, fixture TTS) / unverified (device playback) | TTS accepts only stored validated text, AI-voice label, private expiring playback, cache, once-per-day regeneration, invalidation on transcript change. Audio interruption/route handling on device pending. |
| M08 | Retry and compare learning | verified (API) | Linked retry attempt, per-criterion comparison, guided flag, no mastery from guided/copied retries, history survives (server persistence tested; device relaunch pending). |
| M09 | Daily prompt and review queue | verified (API) | Stable assignment per local date, prompt/rubric versions persisted, timezone snapshot, due-review priority, 7-day prompt freshness fallback, duplicate-day protection (UNIQUE). DST edge cases rely on `Intl` date math; not exercised on device. |
| M10 | Optional daily reminders | implemented_unverified (device) | Opt-in after first completion, local DAILY trigger, generic copy, permission check on settings open, cancel on opt-out/sign-out/deletion, tap → Today with pending-route through sign-in. **Needs devices** for delivery/permission behavior. |
| M11 | Practice a short conversation | verified (API, fixture partner) / unverified (UI on device) | Three-exchange limit, confirmed learner turns, idempotent turns, partner respects disengagement, single session evaluation. Partner speech playback deferred (text replies only). |
| M12 | Learn through the complete curriculum | in_progress | 30 lesson seeds and 30 prompts load; 10 Notice recognition keys authored as drafts (`packages/content/src/recognition.ts`) pending curriculum review; publication manifest empty for production by design. **Blocked**: curriculum review and source-rights decision are owner work. |
| M13 | Buy/restore verified Pro practice | implemented_unverified (sandbox) | RevenueCat client binding to user id, offerings/price from store, purchase/restore/manage, server reconciliation via REST, authenticated webhook with dedupe and environment isolation, immediate refund/expiry effect, atomic caps. **Blocked**: no RevenueCat/App Store/Play credentials or sandbox accounts. |
| M14 | Manage data and get help | verified (API) | Single-practice and account deletion with generation invalidation, storage cleanup proven in tests, reports with consent, reminder cleanup on sign-out, subscriptions explained separately. Provider-side (RevenueCat customer) deletion is a recorded owner step. |
| M15 | Release a monitored pilot build | planned | Requires devices, credentials, store metadata, legal pages, monitoring project. Nothing published or submitted. |

## Deviations recorded

- The handoff proposed `apps/worker/`; this repo uses `apps/server/` with two entry points (API and worker) sharing domain code. Rationale: one deployable with one configuration surface.
- Metro cannot resolve NodeNext `./x.js` imports to `.ts` sources; `apps/mobile/metro.config.js` adds a resolver shim and the mobile app imports only `@marshmemos/contracts/api` and `/types` (no Ajv in the app bundle).
- System typography is used without the rounded variant (no reliable cross-platform rounded system font API); tokens otherwise applied.
- Roleplay partner replies are text only in V1 (partner TTS deferred); learner turns still go through record → confirm.
- Local PostgreSQL 16 and ffmpeg were installed in the ephemeral build container solely to run the database suite and to encode real test audio fixtures; the repository itself requires only Node, pnpm and a Postgres connection string for tests.
- The handoff assumed Supabase Auth (email one-time codes) and Supabase Storage; the owner chose Railway with plain email + password sign-in and an S3-compatible bucket. Both original modes remain selectable (`AUTH_MODE=supabase`, `STORAGE_MODE=supabase`) but are not deployed.
- The handoff proposed OpenAI transcription/TTS; the owner chose Gemini for audio and OpenRouter for text. Gemini TTS returns PCM, stored as WAV (larger than MP3, same 24 h TTL); OpenAI audio remains selectable.
- The `supabase/` directory name is kept for the migrations even though the deployed database is Railway Postgres; renaming would churn the handoff validator and tests for no functional gain.

## Owner setup required before pilot

1. Railway: create the shared `AUTH_JWT_SECRET`; set rotated `TEXT_AI_API_KEY` (OpenRouter) and `AUDIO_AI_API_KEY` (Gemini)
   on `api` and `worker`; connect both services to the repository branch; confirm the first deploy's `/healthz`.
2. Choose/confirm model IDs (`TRANSCRIPTION_MODEL`, `EVALUATION_MODEL`, `REWRITE_MODEL`, `VERIFIER_MODEL`, `ROLEPLAY_MODEL`,
   `TTS_MODEL`, `TTS_VOICE`) after running the calibration suite; confirm the OpenRouter route honors strict structured
   outputs for the chosen models (`require_parameters` refuses routes that do not).
3. RevenueCat project, App Store/Play products, entitlement `pro`, webhook Authorization value, sandbox testers; then
   `BILLING_PROVIDER=revenuecat` with its variables.
4. Apple/Google app identifiers (placeholders `com.marshmemos.app`), signing, development builds on physical iOS and
   Android devices pointed at the Railway API; run the first vertical slice with two disposable accounts per
   `handoff/docs/07-verification.md`.
5. Curriculum review of seeds and Notice keys; rights decision; populate `packages/content/src/publication/production.json`.
6. Monitoring DSN, support/privacy/terms/deletion URLs, operator facts.

## Release statuses

- Internal build: **not compiled here** (source ready; `expo export` bundles succeed).
- Pilot distribution: not started.
- Public deployment: Railway project provisioned; services build from the branch once connected and start once the owner sets the shared signing secret and the rotated model keys (see Railway stack above).
- Store submission: not started (explicitly out of scope for this request).
- Store approval: n/a.
