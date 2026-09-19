# Operations runbook (pilot)

## Services and configuration

- API: `node dist/api.js` (or `pnpm server:api`), health at `GET /healthz` (reports env, provider mode, content manifest).
- Worker: `node dist/worker.js`; polls `jobs`, renews leases, sweeps expired reservations/leases/media every minute.
- Configuration is environment-only (`.env.example`). Production refuses fixture providers, fixture auth, local
  storage, the development content manifest and demo entitlements at startup.

## Rollback levers (no redeploy)

| Situation | Lever |
|---|---|
| Evaluator/rewriter quality regression | Change `EVALUATION_MODEL` / `REWRITE_MODEL` / `VERIFIER_MODEL` and bump `PROMPT_CONFIG_VERSION`; cached results are keyed by config version so nothing is silently reused. |
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

Provider-side retention (OpenAI, RevenueCat) is not configured or claimed here; confirm vendor terms before
the first upload in production.

## Owner dashboard tasks (cannot be automated from this repo)

Supabase project + email OTP + service role; OpenAI key and model access; RevenueCat project, products,
entitlement `pro`, webhook Authorization; Apple/Google identifiers, signing, sandbox testers; monitoring
project; support/privacy/terms/deletion URLs; curriculum and rights review of `publication/production.json`.
