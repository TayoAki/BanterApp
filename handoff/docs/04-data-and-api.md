# Data, authorization, and API contract

## Logical schema

Use UUID primary keys, UTC timestamps, versioned content, foreign keys, and non-null ownership on every private entity. Use decimal-safe integer money only if storing prices; verified product metadata remains the display source. Below is a migration specification, not an applied database schema.

| Table | Columns and constraints |
|---|---|
| profiles | `id` references auth user; locale; timezone; timezone_changed_at; goal; reminder_enabled/time; deletion_generation; account_state |
| framework_versions | framework_id + version PK; source metadata; criterion JSON; published_at; content hash; immutable after publish |
| source_examples | stable example_id + version; source filename/pages/hash; exact text; teaching_use; publication state |
| lesson_versions | lesson_id + version PK; framework version FK; stage; source IDs; prompt ID/version; recognition answer key; status |
| prompt_versions | prompt_id + version PK; framework version FK; text; criteria; kind; level; status |
| daily_assignments | UUID; user_id; local_date; timezone_snapshot; prompt_id/version; UNIQUE(user_id, local_date) |
| practice_sessions | UUID; user_id; assignment_id nullable; mode; framework version; status; quota_window_utc; reservation_id; client_key; UNIQUE(user_id,client_key) |
| attempts | UUID; user_id; session_id; ordinal; retry_of nullable; current_revision; stage; deleted_at; UNIQUE(session_id,ordinal); composite ownership FK |
| transcript_revisions | attempt_id + revision PK; user_id; raw_text; confirmed_text nullable; confirmed_at; edited flag; audio_asset_id nullable; immutable after confirmation |
| audio_assets | UUID; user_id; attempt_id; kind raw/tts; object_key UNIQUE; verified mime/bytes/duration; rewrite_id nullable; expires_at; deleted_at |
| evaluations | UUID; user_id; attempt_id + revision; model/prompt/rubric versions; validated structured result; server totals; status; UNIQUE(attempt_id,revision,config_version) |
| rewrites | UUID; user_id; evaluation_id; revision; validated text; fact-check state; rewrite-evaluation reference; status; config version; UNIQUE(evaluation_id,config_version) |
| skill_evidence | UUID; user_id; framework/version; attempt_id; guided flag; qualification; timestamp; UNIQUE(attempt_id,rubric_version) |
| skill_progress | user_id + framework_id PK; state; review_step; next_due_at; last_practiced_at; derivable from evidence |
| completions | user_id + lesson_id + lesson_version UNIQUE; attempt_id; local_day; XP; server writes only |
| quota_windows | user_id + UTC date PK; allowed_sessions; reserved; committed; nonnegative CHECKs |
| reservations | UUID; user_id; window; session_id UNIQUE; status reserved/committed/released; expiration |
| jobs | UUID; user_id; attempt_id nullable; type; revision; generation; stage_key UNIQUE; state; scheduled_at; lease_until; retries; checkpoint; error_code |
| entitlements | user_id + entitlement_key PK; provider customer ID; source environment; state; verified expiry/grace; reconciled_at |
| billing_events | provider + environment + event_id UNIQUE; verified payload reference/minimized data; processed_at; state; retry_count |
| reports | UUID; user_id; evaluation_id; reason; consented evidence snapshot nullable; processing state |
| deletion_jobs | UUID; user_id; generation; steps; retry state; requested/completed timestamps |

Composite ownership: a user's attempt cannot reference another user's session. Enforce with `(session_id,user_id)` foreign keys or equivalent transactional checks plus row policies. Repeat for evaluation/attempt, audio/attempt, rewrite/evaluation, and report/evaluation. Index user+created_at for private lists, jobs(state,scheduled_at), assets(expires_at), progress(next_due_at), and entitlement lookups.

## Authorization

Enable RLS on every exposed table, with default deny and explicit grants. Authenticated users may read their own profile/progress/attempts/evaluations. They may update only validated profile/preferences through constrained operations, not score, role, account_state, quota, content publication, or entitlement fields. Expose server mutations for stateful operations. Do not grant direct client write access to jobs or computed results.

Public content queries return only published versions and public examples. Internal draft preview requires an explicit server-held editor capability; a client flag is insufficient. An editor does not automatically read learner conversations. Support access is narrowly scoped, audited, and consent-based for transcript evidence.

Storage buckets are private. RLS or server-only issuance restricts paths to actual ownership. Signed URLs are capabilities with short expiry; server authorization occurs on every issuance, not only in the UI. Never return a public bucket URL for learner audio. Service-role access lives in worker/API secrets and bypasses RLS only behind explicit ownership checks. Ignore client owner IDs.

## Endpoint conventions

Prefix `/v1`. All private endpoints require a verified bearer session. Derive `user_id` server-side. JSON errors: `{code, message, retryable, request_id}` with no secret/provider payload. Return 401 unauthenticated, 403 denied, 404 missing or deliberately concealed foreign resources, 409 conflicting revision/state, 413 size, 422 unsupported/invalid content, 429 quota/rate limit, 503 transient outage. UUIDs are validated; client keys are 16–128-character bounded opaque strings scoped per owner and action. Do not accept arbitrary URLs for transcription/TTS.

| Method/path | Request | Response / side effect |
|---|---|---|
| GET `/catalog` | optional pagination cursor | Published framework/lesson outlines; no drafts |
| GET `/lessons/:id?version=N` | published version | Exact source records, learning targets, exercise |
| GET `/today` | none | Idempotently resolves owned daily assignment and current allowance |
| POST `/sessions` | assignment_id OR approved prompt_id/version; mode; client_key | 201/200 session_id, allowance reservation, declared limits |
| POST `/sessions/:id/attempts` | ordinal; retry_of nullable; client_key | Owned attempt ID, max media bounds; validates included retry budget |
| POST `/attempts/:id/upload` | expected bytes/mime; client_key | Expiring single-object upload URL, asset_id; server-generated path |
| POST `/attempts/:id/upload-complete` | asset_id; client_key | 202 job_id; verify media, queue transcription exactly once |
| GET `/attempts/:id` | none | Current stage, raw/confirmed transcript revisions, validated feedback IDs, recoverable errors |
| PUT `/attempts/:id/transcript` | expected_revision; confirmed_text; client_key | New immutable confirmed revision; cancel/supersede older dependent work |
| POST `/attempts/:id/evaluate` | revision; client_key | 202 evaluation job; confirm revision and quota; no client rubric override |
| POST `/evaluations/:id/rewrite` | client_key | 202 rewrite pipeline; original transcript/rubric resolved server-side |
| POST `/rewrites/:id/speech` | supported voice preset; client_key | Existing authorized asset or queued TTS job; no arbitrary text |
| GET `/assets/:id/playback` | none | Owner-authorized expiring playback capability if ready/not deleted |
| GET `/jobs/:id` | none | Owned minimal status; validated result ID or sanitized error |
| POST `/sessions/:id/roleplay-turn` | confirmed attempt/revision; expected_turn; client_key | Bounded partner reply job; respects three-exchange limit |
| GET `/progress` | optional cursor for history | Server-derived skill/XP/streak/due reviews |
| PATCH `/preferences` | permitted goal/timezone/reminder fields only | Validated saved preferences; client reschedules local reminder |
| POST `/entitlements/restore` | client_key | Provider reconciliation request and current state; no grant from client claims |
| POST `/reports` | evaluation_id; reason; share_evidence bool | Report receipt; if false no transcript evidence copied |
| DELETE `/attempts/:id` | recent auth if policy requires | 202 purge, invalidate jobs and media; recompute affected progress |
| POST `/account/deletion` | recent-auth proof; client_key | 202 deletion_job_id; revoke new access and cleanup |
| POST `/billing/events` | provider event, configured authenticity proof | Provider-authenticated endpoint; unique event record and reconciliation |

The first transcript confirmation uses `expected_revision=0`; transcript revisions begin at 1. Typed fallback creates an attempt without raw audio, labels input mode typed, and follows the same confirmation/evaluation contract. Bounds: confirmed text 1–4,000 Unicode characters; reject blank-only input. The model receives bounded context independent of string size. Never silently truncate a user's confirmed response and grade only part of it.

## Consistency and deletion

Transactionally create attempt/job/reservation changes. Use optimistic revisions to reject concurrent edits. A stale evaluator result never replaces a later valid evaluation. Deletion increments generation and marks the subject inaccessible before asynchronous provider/storage cleanup. Workers recheck generation before committing, and cleanup retries remove objects even when their result arrived after deletion. Recomputing progress after history deletion must not recreate removed transcript records; retain only declared allowed aggregates if the user's selected deletion scope permits them.

Quota reservation locks the user's UTC window row; count reserved + committed against allowance. Commit/release transitions compare current state in a transaction, so concurrent requests cannot double-debit or exceed the cap. Reservation expiry must not release actively leased work without reconciliation. Granting Pro mid-window increases the cap, not resets usage. Refund/expiry updates access immediately according to verified effective state while preserving existing user-owned history.
