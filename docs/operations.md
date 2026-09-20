# Operations runbook (pilot)

## Services and configuration

- Hosting: Railway project `marshmemos` (production environment) with `Postgres`, the private bucket
  `practice-audio`, and two services built from `apps/server/Dockerfile` (build context = repository root):
  `api` (`node dist/api.js`, health at `GET /healthz`, reports env, provider mode, auth mode, storage kind,
  content manifest) and `worker` (`node dist/worker.js`; polls `jobs`, renews leases, sweeps expired
  reservations/leases/media every minute). Both run migrations on start under an advisory lock, so
  simultaneous starts are safe.
- Configuration is environment-only (`.env.example`). Railway variables reference `${{Postgres.DATABASE_URL}}`,
  `${{practice-audio.BUCKET|ACCESS_KEY_ID|SECRET_ACCESS_KEY|REGION|ENDPOINT}}` and the shared
  `AUTH_JWT_SECRET`; `TEXT_AI_API_KEY` (OpenRouter) and `AUDIO_AI_API_KEY` (Gemini) are set by the owner.
  Production refuses fixture providers, fixture auth, local storage, the development content manifest and
  demo entitlements at startup, and refuses to start without the keys for the selected modes.
- Accounts: `POST /v1/auth/register|login|refresh|logout|password`. Access tokens are HS256 JWTs signed with
  `AUTH_JWT_SECRET` (1 h); refresh tokens are opaque, single-use and rotate (60 days). Rotating
  `AUTH_JWT_SECRET` only invalidates access tokens; clients refresh transparently. Ten failed sign-ins per
  email in 15 minutes lock the email for 15 minutes; thirty per IP are refused.

## Rollback levers (no redeploy)

| Situation | Lever |
|---|---|
| Evaluator/rewriter quality regression | Change `EVALUATION_MODEL` / `REWRITE_MODEL` / `VERIFIER_MODEL` (OpenRouter model IDs) and bump `PROMPT_CONFIG_VERSION`; cached results are keyed by config version so nothing is silently reused. |
| Transcription or speech regression | Change `TRANSCRIPTION_MODEL` / `TTS_MODEL` / `TTS_VOICE`, or switch `AUDIO_AI_TRANSCRIBE_API` between `interactions` and `generate_content`; or set `AUDIO_AI_PROVIDER=openai` with an OpenAI key. |
| Leaked or suspected key | Rotate it at the provider, replace the Railway variable, redeploy. A key that was pasted into a chat or ticket is rotated, never reused. |
| Compromised session signing key | Replace the shared `AUTH_JWT_SECRET`; every access token dies immediately and clients refresh. To end all refresh sessions too, `update auth.refresh_tokens set revoked_at = now() where revoked_at is null`. |
| A lesson or prompt must be pulled | Set its entry to `retired` (or remove `published`) in `packages/content/src/publication/production.json` and redeploy the server; content versions are refreshed idempotently on start. Existing history stays readable. |
| Provider outage | Set `FREE_SESSIONS_PER_UTC_DAY=0` and `PRO_SESSIONS_PER_UTC_DAY=0` to stop new reservations; existing feedback remains readable; failed jobs surface recoverable errors and release reservations. |
| Billing mismatch | `POST /v1/entitlements/restore` per user or run `reconcile_entitlement` jobs; entitlement state always follows the provider fetch, never the webhook body. |
| Bad native build | Corrective build via EAS/`expo run:*`; remote config cannot fix native defects. |

## Signals to monitor (from handoff/docs/06)

- Upload failures: `audio_assets.state = 'rejected'` rate; 413/422 counts.
- Provider errors/latency: `jobs.error_code like 'provider_%'`, `evaluations.provider_meta.latency_ms`, `billing_uncertain` checkpoints.
- Queue health: `jobs` where `state='running' and lease_until < now()`; oldest `queued` age; `sweep_exhausted_jobs` counts.
- Invalid assessments: `jobs.error_code = 'invalid_model_output'`; rewrite `fact_check_state='failed'` rate.
- Payment without access: `billing_events.state in ('failed','ignored')` with `reason`; entitlements `state='pending'` older than an hour.
- Deletion: `deletion_jobs.state='failed'`; assets with `deleted_at` set and `storage_deleted_at` null.
- Cost per successful session: sum provider usage from `evaluations.provider_meta` and TTS asset counts per committed reservation.

Never log audio, transcripts, tokens or provider payloads; the logger redacts common fields as defense in depth.

## Data inventory and retention (implemented defaults)

| Data | Where | Retention | Removal |
|---|---|---|---|
| Raw recordings | private bucket `users/<uid>/attempts/<attempt>/raw/` | 24 h (`RAW_AUDIO_TTL_HOURS`) | worker sweep deletes object then marks row `expired`; attempt/account deletion |
| TTS audio | private bucket `.../tts/<rewrite>/` | 24 h (`TTS_TTL_HOURS`) | same |
| Transcript revisions, evaluations, rewrites | Postgres | until learner deletes practice/account | hard delete in `delete_attempt` / `delete_account` jobs |
| Progress aggregates | Postgres | until account deletion | recomputed after single-practice deletion; deleted with account |
| Entitlement row | Postgres | minimized on account deletion (customer id cleared) | store subscription managed by the store |
| Billing events | Postgres | minimized payload (type, product) | owner-defined retention |
| Telemetry | Postgres | IDs/states only | deleted with account |
| Reports | Postgres | transcript evidence only with consent | deleted with the practice/account |

Provider-side retention (OpenRouter and the upstream model vendors, Google Gemini, RevenueCat) is not configured or
claimed here; confirm vendor terms (including OpenRouter's per-provider data policies) before the first upload in production.

## Owner dashboard tasks (cannot be automated from this repo)

Rotated OpenRouter key (`TEXT_AI_API_KEY`) and Gemini key (`AUDIO_AI_API_KEY`) as Railway variables on `api` and
`worker`; first live call per model recorded in `PLAN.md`; RevenueCat project, products, entitlement `pro`, webhook
Authorization; Apple/Google identifiers, signing, sandbox testers; monitoring project; support/privacy/terms/deletion
URLs; curriculum and rights review of `publication/production.json`.
