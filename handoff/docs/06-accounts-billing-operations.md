# Accounts, billing, privacy, and operations

## Accounts

Guest sample is authored and does not call audio/LLM services. Sign-in precedes cloud voice upload. Use email one-time codes initially; preserve pending route. Configure production/development URLs, code expiry/resend limits, and native callback behavior against the installed provider. Persist tokens through a supported secure native storage adapter; verify real cold starts and expiry. Do not treat public client keys as privileged secrets.

Derive user identity from verified server sessions. Learner ownership, editor privilege, and Pro entitlement are distinct. Logout clears user-specific caches, player state, local audio, scheduled reminders, and billing SDK identity. Switching accounts must not expose the last user's transcript or paid status. Do not merge accounts based only on matching email text.

If adding social sign-in, review Apple's conditional equivalent-login requirements rather than assuming any provider combination is sufficient. Both supported platforms require their own real sign-in tests. The app needs in-app account deletion; Google Play account-creating apps also need a web deletion-request resource. [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/), [Google deletion guidance](https://support.google.com/googleplay/android-developer/answer/13327111).

## Billing and entitlements

One app-wide Pro entitlement with one proposed monthly product. Native store billing is the default for digital in-app learning; storefront-specific alternatives need a separate current review. Exact price/period/currency/availability come from the store. No hard-coded invented price or unconfigured trial. Restore and Manage are visible. [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/), [Google payments](https://support.google.com/googleplay/android-developer/answer/9858738).

Bind the billing customer to the stable signed-in app ID before purchase. Server checks current provider entitlement for protected server work. Verify webhook authenticity using the provider's documented mechanism, unique event/environment IDs, product mapping and buyer binding. Reconcile after stale or out-of-order events, restore, refund, uncertain verification, and periodically for active records. Do not grant from a client success callback alone.

Pending/unknown grants free scope. Active grants paid scope to verified expiry. Canceled renewal retains already-paid access until expiry. Grace requires verified provider state and a bounded end. Refunded/revoked follows effective reconciled state. Define restoration/account-transfer behavior before tests; a purchase made on A must not silently unlock B on the same phone. No creator ledger or payouts in this product.

## Data lifecycle

Recommended app defaults: raw recordings and TTS assets expire within 24 hours; confirmed practice and progress persist until cleared; no raw audio in analytics; no replay capture. Describe actual vendor transfer before the first upload. Do not claim provider-side zero retention without an applicable verified configuration/contract.

Deletion uses recent authentication, an inaccessible/deleting account state, generation invalidation, session revocation, queue cancellation, object cleanup, transcript/evaluation/derived-progress cleanup, provider identity cleanup where supported, then completion. Partial failure is retried with an observable deletion job. Prevent late AI jobs from recreating deleted data. Any necessary retained billing/audit fields must be minimized and explained with owner-approved retention periods. Store subscription renewal management is separate from account deletion; show that truthfully.

For single-practice deletion, remove associated raw/TTS media, transcript revisions, evaluations and rewrites and recompute affected skill evidence. Support reporting shares the transcript only with a deliberate user choice. Test this consent path with no private material embedded in diagnostic logs.

## Minimal telemetry and service monitoring

Product events: practice_started, recording_finished, transcript_confirmed, feedback_ready, rewrite_ready, playback_started, retry_completed, independent_review_completed, reminder_opted_in, offer_viewed, purchase_verified, feedback_reported, deletion_completed. Event IDs deduplicate; server defines paid/completion events. Properties are IDs, versions, durations, states, platform, and bounded error categories, not raw speech/text/email. Exclude test traffic.

Monitor audio-upload failure, provider error/latency, queue age/expired leases, invalid or unsupported assessments, rewrite fact-check rejection, verified payment without access, deletion-cleanup failure, and cost per successful session. Version releases, prompts, rubrics and models. Verify a harmless test event arrives at the intended monitoring project; source maps must make crashes actionable. Disable recording/session replay by default.

Assign an engineering owner for outages/access/deletion, curriculum owner for scoring complaints, and product owner for offers/support. Operational thresholds to tune: alert on stuck jobs beyond the terminal deadline, any verified purchase/access mismatch, failed deletion retry exhaustion, and sustained provider error spikes. Do not alert on ordinary user cancellations.

## Release packet

Collect physical-device test records, store sandbox purchase evidence, exact data inventory/retention decisions, working support/privacy/terms/deletion URLs, accurate screenshots from the running app, content-rights confirmation, reviewed mature-content selection, actual age-rating answers, app review access, known issues, and monitoring evidence. Do not publish placeholder legal pages with an invented operator address or contact.

Marketing draft: “Practice speaking with a little more personality.” Explain daily prompts, framework-specific coaching, rewrites, and AI voice playback only after those features work. The source includes adult/profane material; evaluate actual published selection under store content rules. Do not promise store acceptance or use a name availability claim without checking it.

Rollback: disable a failing model route or lesson version, retain readable authored content/history, revert prompt/rubric/model config with audit history, stop new reservations if service health fails, and reconcile pending jobs/entitlements. Native defects need a corrective build; not every bug is fixable by a remote content change. Public submission/deployment is outside this build handoff's authorization.
