# marshmemos implementation plan (living status)

The original plan is `handoff/PLAN.md` (unchanged). This file records what was built, what was
observed, and exact blockers. Statuses: `planned`, `in_progress`, `implemented_unverified`,
`verified`, `blocked`, `deferred`. "Verified" here means acceptance evidence from automated tests
run in this repository against a real PostgreSQL; it does **not** mean physical-device or live-provider
evidence unless that is stated explicitly.

Environment used for all evidence below: Linux x86_64 container, Node 22.22.2, pnpm 10.33.0,
PostgreSQL 16.15 (local, plain Postgres with `supabase/local/auth_stub.sql`), no network access to
Expo/OpenAI/Supabase/RevenueCat documentation or services, no iOS/Android device or emulator, no provider
credentials. Package versions are locked in `pnpm-lock.yaml` (Expo 57.0.24, React Native 0.86.3,
React 19.2.3, expo-router 57.0.22, expo-audio 57.0.5, expo-notifications 57.0.20, expo-file-system 57.0.7,
@supabase/supabase-js 2.116.0, react-native-purchases 10.10.0, hono 4.13.8, postgres 3.4.9, openai 7.20.0,
ajv 8.20.0, zod 4.6.5, jose 6.2.12, TypeScript 6.0.3, vitest 5.0.1).

## Evidence summary (this revision)

| Check | Result |
|---|---|
| `pnpm typecheck` (contracts, content, server, mobile) | pass |
| `packages/contracts` tests | 43 passed (fixture totals 6/9 = 6/6 + 0/3; hallucinated evidence, borrowed criteria, wrong revision/framework/source id, null-score rules, low-confidence withholding, rewrite fact checks, verifier spans, improvement labeling, source-copy detection on all 20 examples, provider schema translation) |
| `packages/content` tests + `pnpm content:validate` | 11 passed; 407 integrity checks incl. 10 PDF SHA-256, 20 verbatim quotes in page text, statements on page 1, 30 prompts/30 lessons, 10 authored Notice keys quoting exact spans |
| `apps/server` unit tests | 18 passed (config guards, prompt template byte-equality, MP4/MP3 probe on real ffmpeg-encoded fixtures, Supabase-shaped JWT verification incl. recent-auth from `amr`) |
| `apps/server` DB tests (`pnpm test:db`) | 43 passed: quota concurrency (2 simultaneous starts admit 1), idempotent reserve/commit/release, Pro mid-window cap raise, expired-reservation guard with active job, CHECK cap; job claim with SKIP LOCKED across 2 workers, lease expiry reclaim, lost-lease commit refusal, retry/backoff/terminal failure, requeue of same logical stage, sweeper, cancellation; RLS own-row reads, anon published-only, no client access to jobs/assets/reservations/billing, no client writes, composite ownership FK; full API journey (below) |
| `apps/mobile` tests | 9 passed (format helpers; exact production copy present per docs/05, "Framework fit"/"Hear a stronger version" absent) |
| `tests` package | handoff validator PASS, repository layout, no secrets in `.env.example` |
| `npx expo config --type introspect` | NSMicrophoneUsageDescription exact text, RECORD_AUDIO, scheme `marshmemos`, bundle/package `com.marshmemos.app`, `FOREGROUND_SERVICE_MICROPHONE` blocked |
| `npx expo export --platform ios` / `android` | Hermes bundles built (5.3 MB / similar), all monorepo imports resolve |
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

## Slice status

| ID | User outcome | Status | Evidence / remaining |
|---|---|---|---|
| M00 | Reproducible mobile/worker project | verified (repo) | pnpm workspace, locked versions, `.env.example`, explicit fixture mode refused in production (config tests), content validator passes. Native dev builds are configured (`expo-dev-client`, plugins) but were not compiled here: **needs Xcode/Android SDK** (`npx expo run:ios|android`). |
| M01 | Read original framework lessons | implemented_unverified (device) | Catalog/lesson API serve published versions only; drafts require the server-held editor role; source quotes render from corpus records with editorial labels; long quotes scroll (`SourceQuote`). Screen-level verification pending on device. |
| M02 | Sign in and keep own progress | implemented_unverified (service) | Supabase email OTP client with encrypted large secure storage, JWKS/HS256 server verification, own-row RLS, two-user API denial verified in tests. **Blocked for live check**: no Supabase project/credentials; cold-start and expiry to be tested on device. |
| M03 | Speak and review a local take | implemented_unverified (device) | expo-audio recorder, metering-driven waveform, 90 s cap (`forDuration` + guard), background/interruption stop with preserved take, document-directory persistence with 24 h expiry, typed alternative, permission-denied copy. **Needs physical devices** for permissions, containers, lifecycle. |
| M04 | Receive and correct a transcript | verified (API, fixture STT) / unverified (live STT) | Private signed upload, byte/format/duration validation, exactly-once transcription job, review/edit/confirm with revisions, offline retry copy, wrong-owner 404. **Live transcription not run** (no `AI_API_KEY`). |
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

## Owner setup required before pilot

1. Supabase project (dev + prod): apply `supabase/migrations`, enable email OTP, note URL/publishable key/service-role key, JWKS (or legacy JWT secret).
2. OpenAI (or compatible) key; choose `TRANSCRIPTION_MODEL`, `EVALUATION_MODEL`, `REWRITE_MODEL`, `VERIFIER_MODEL`, `ROLEPLAY_MODEL`, `TTS_MODEL` after running the calibration suite; confirm structured-output support for the translated schemas.
3. RevenueCat project, App Store/Play products, entitlement `pro`, webhook Authorization value, sandbox testers.
4. Apple/Google app identifiers (placeholders `com.marshmemos.app`), signing, development builds on physical iOS and Android devices; run the first vertical slice with two disposable accounts per `handoff/docs/07-verification.md`.
5. Curriculum review of seeds and Notice keys; rights decision; populate `packages/content/src/publication/production.json`.
6. Monitoring DSN, support/privacy/terms/deletion URLs, operator facts.

## Release statuses

- Internal build: **not compiled here** (source ready; `expo export` bundles succeed).
- Pilot distribution: not started.
- Public deployment: not started.
- Store submission: not started (explicitly out of scope for this request).
- Store approval: n/a.
