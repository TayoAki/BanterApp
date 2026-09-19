# marshmemos implementation plan

Status at handoff: specifications/assets/seeds provided; no app, database, provider, purchase, or device integration implemented. All features below start `planned`. Builder updates status and evidence on the actual changed revision. “Verified” requires acceptance evidence, not compilation alone.

| ID | User outcome | Dependencies | Acceptance gate | Status |
|---|---|---|---|---|
| M00 | Reproducible mobile/worker project | None | Compatible versions locked, native dev builds configured, secrets separated, fixture mode explicit, content validator passes | planned |
| M01 | Read original framework lessons | M00 | Ten units load; exact source hash/text stable; quoted/editorial/generated labels distinct; long quotes scroll; unpublished drafts hidden | planned |
| M02 | Sign in and keep own progress | M00 | Email code, cold restart, expiry, sign-out, destination resume; two-user read/write denial; secure session storage verified | planned |
| M03 | Speak and review a local take | M02 | Permissions, real metering/timer, play/discard/re-record, foreground stop, 90s cap, typed alternative, actual device file | planned |
| M04 | Receive and correct a transcript | M03 | Private upload, validated bytes/format/duration, durable STT job, review/edit/confirm, offline retry, wrong-owner denial | planned |
| M05 | Get strict framework feedback | M01,M04 | Exact revision/rubric/evidence validated; correct server totals; uncertainty supported; injection/source-copy cases; persisted result | planned |
| M06 | Read a truthful improved version | M05 | Fact checks, separate rewrite evaluation, no invented biography; needs-detail path; original feedback remains on failure | planned |
| M07 | Hear the approved rewrite | M06 | TTS exactly matches validated text, AI voice label, private playback, controls, audio interruption, retry without double charge | planned |
| M08 | Retry and compare learning | M07 | New linked attempt; criterion comparison; guided flag; no mastery from copied/coached retry; saved history survives relaunch | planned |
| M09 | Get a daily prompt and review queue | M08 | Stable assignment across launches, actual prompt/rubric versions, timezone/DST handling, due selection, duplicate-day protection | planned |
| M10 | Receive optional daily reminders | M09 | Opt-in after first completion, local scheduling, denial/settings, opt-out/sign-out cancellation, deep link through auth | planned |
| M11 | Practice a short conversation | M05,M07 | At most three exchanges, each spoken input confirmed, partner respects context/no, turn idempotency, full-session evaluation | planned |
| M12 | Learn through the complete curriculum | M01,M05,M09 | All 30 lesson seeds developed/reviewed with Notice answer keys; 30 daily prompts checked; exact source/critique handling; 10-unit unlocks | planned |
| M13 | Buy/restore verified Pro practice | M02,M09 | Real sandbox product, authentic event handling, purchase/pending/cancel/restore/expiry/refund, wrong-account tests, atomic caps | planned |
| M14 | Manage data and get help | M02,M08 | Single-practice/account deletion, in-flight invalidation, storage cleanup, provider lifecycle, support/report consent, reminder cleanup | planned |
| M15 | Release a monitored pilot build | M00–M14 | Device matrix, AI evaluation gate, links/data disclosures, actual screenshots, age/content selection, monitoring delivery, rollback runbook | planned |

## Slice execution template

For each M-ID record: objective; relevant source/spec files; entry/exit states; migration/API/UI changes; checks run and results; screenshots; build/device/environment; remaining limitations; next dependency. Use statuses `planned`, `in_progress`, `implemented_unverified`, `verified`, `blocked`, `deferred`.

First end-to-end milestone is M00–M08 with only F02 fixture content: a real learner records, gets a confirmed transcript and grounded feedback, hears a valid rewrite, retries, and sees saved results. Then broaden to daily scheduling/curriculum/paid access. Do not build every screen with fake data before proving this path.

Content generation can run locally before provider credentials arrive. Keep fixture results explicitly labeled and isolated from production. If a physical device, provider dashboard, signing identity, or billing account is unavailable, complete independent code and list the precise pending verification. Do not substitute a web screenshot for a native audio/purchase test.

## Required completion report from the builder

Summarize implemented behavior, repository revision, tested environments, acceptance results per feature, actual live/sandbox integrations, measured provider latency/cost, content/rubric versions, remaining owner setup, and separate statuses for internal build, pilot distribution, public deployment, store submission, and store approval. Do not mark public release complete from an internal build.
