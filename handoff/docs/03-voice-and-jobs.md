# Voice pipeline and durable jobs

## Recording client

Use the installed, version-matched `expo-audio` API for recording and playback. Configure an explicit microphone explanation: “marshmemos uses your microphone to record practice you choose to send for feedback.” Disable background recording. Ask only after Start speaking. Permission refusal offers Open settings and Type instead, with no repeated automatic prompt. Expo documents recording/playback and recording lifecycle behavior in [expo-audio](https://docs.expo.dev/versions/latest/sdk/audio/).

Client states: `idle → permission → recording → recorded → uploading → transcribing → transcript_review → evaluating → feedback`. Rewriting and TTS are independent sub-states after feedback. Retrying creates a new attempt linked to the first, not an overwrite. Failed network/provider stages show their own recovery action. A client timeout does not imply a server job stopped.

Record a mono compressed format supported on both platforms and by the transcription adapter; proposed M4A/AAC. Select sample rate/bitrate after device/provider verification. Target 30–60 seconds, hard cap 90 seconds, server maximum 10 MiB. Enforce both decoded duration and actual bytes server-side. Test iOS/Android containers rather than trusting a filename. The OpenAI file-transcription guide currently supports M4A and several other formats with a 25 MB provider file limit; this app deliberately uses a smaller limit. [Speech-to-text](https://developers.openai.com/api/docs/guides/speech-to-text).

Starting recording stops existing playback and acquires the audio session. Show live elapsed time, visible recording status, waveform derived from actual metering when available, and a Stop button with an accessible label. Do not show decorative metering as if actual. At 90 seconds, stop cleanly and show the captured take. No pause/resume requirement in V1.

On navigation away, screen lock, app backgrounding, incoming-call interruption, or audio-route loss, stop recording and preserve a valid partial file when possible. Show “Recording stopped. Review this take or record again.” Never silently resume the microphone. On low storage or invalid/empty output, explain and offer another take. Release microphone/player resources on exit.

After Stop, show duration, Play, Record again, Discard, and Use recording. No upload until Use recording. Keep the local file until transcript confirmation or explicit discard; preserve an interrupted upload in app-private storage for up to 24 hours, with a visible pending-practice entry. Device caches can be evicted, so verify the chosen file location and implement an expired/missing-file state. User/account sign-out clears private local practice content.

## Upload and transcription

1. Authenticated client creates/gets a practice session and attempt using stable idempotency keys. Server reserves allowance before creating a signed upload capability.
2. Server derives an object key from verified user ID, attempt UUID, and expected recording role. Client-supplied bucket/path/owner is never trusted.
3. Issue a short-lived upload URL scoped to one object with constraints where supported. Client uploads directly to private storage, then calls upload-complete.
4. Server verifies object ownership, byte size, allowed decoded media format/duration, and session validity. A client duration/hash is advisory. Reject malformed media before sending it to a provider.
5. Transactionally queue the transcription job and return attempt/job IDs. No public audio URLs. Use a private SDK read or a tightly scoped temporary read URL only where the provider integration needs it.
6. Worker submits the audio for literal transcription. It receives no framework examples, ideal answers, or grading instructions that could bias the transcript toward the expected answer. Optional language hint is English; preserve spoken wording rather than polishing it.
7. Persist `transcript_raw`, provider metadata, and any provider-supported uncertainty information. Do not fabricate word-confidence scores if the model does not provide them.
8. UI shows editable transcript and original playback. The user explicitly confirms `transcript_confirmed` and revision. Silence, unsupported language, poor recording, or low usable content leads to re-record/type alternatives rather than a score.

A speech detector or transcript-length heuristic can flag suspicious input, but neither establishes that a hallucinated transcript is accurate. Confirmation is the primary safeguard. Avoid judging filler frequency from a provider transcript that may omit fillers. Audio feedback in V1 is about confirmed words and structure.

## Evaluation, rewrite, and synthesis

Evaluation starts only for a confirmed revision. Persist raw and confirmed texts separately; edits create a new immutable revision. Before committing results, compare the revision and deletion generation. Stale outputs remain inaccessible and do not advance progress. One transcript correction/reassessment is included per attempt; further changes create a new practice or a bounded explicit continuation, not unlimited model calls.

Feedback can be used even if rewrite or TTS fails. Generate a rewrite on request, validate facts and rubric improvement, then expose it. Speech generation accepts only the stored validated rewrite ID/revision, never arbitrary client text. TTS playback must use exactly that approved text. Add visible “AI-generated voice,” as required by the documented speech service behavior. Use a standard provider voice, no voice cloning. [Text-to-speech](https://developers.openai.com/api/docs/guides/text-to-speech).

Cache synthesized audio privately for the current user/rewrite/model/voice revision. Default TTL 24 hours; remove with attempt/account deletion. A later replay may regenerate after expiry under a bounded TTS regeneration policy (proposed once per rewrite per UTC day); text remains usable if generation is unavailable. Use a private owner-authorized signed read URL, proposed TTL five minutes. Any already-issued URL may remain usable until expiry unless storage deletion or provider controls revoke it; do not promise instant revocation of downloaded bytes.

Player: play/pause/replay, duration/position, 0.8x/1x/1.2x playback options, and a text transcript. Stop on navigation/sign-out; do not play over a new recording. Background playback is not required in V1. Handle audio route changes and system interruptions separately from content-generation failures.

## Durable server jobs

Recommended queue: Postgres `jobs` rows processed by a dedicated Node worker, using a transaction and `FOR UPDATE SKIP LOCKED` to claim ready work. The API transaction creates the job and domain status together. A sweeper reclaims expired leases and marks exhausted jobs failed. Do not run long audio pipelines inside a request handler with an uncertain hosting timeout.

Job fields: type, owner, attempt, transcript revision, idempotency key, state, scheduled time, lease expiry, worker ID, attempts, maximum attempts, checkpoint, error code, deletion generation. States `queued`, `running`, `succeeded`, `failed`, `canceled`; an expired lease permits retry. Each successful stage writes its artifact and checkpoint transactionally before dependent scheduling. Use uniqueness on stage/attempt/revision/provider configuration version. Commit only if the attempt exists, revision matches, owner is active, and job still owns its lease.

Proposed request timeouts: transcription 60 seconds, evaluator 30, rewriter 30, verifier 30, TTS 45. Total attempts per stage max two. Use retry-after-aware bounded backoff for provider 429/5xx/network errors; do not retry bad inputs or denied access. Configure worker leases longer than one request and renew them. Values are implementation defaults to tune with actual latency and host limits.

Mobile polls authenticated job status with increasing intervals (about 1, 2, then 4 seconds) and pauses on background/unmount. Reconnect resumes by attempt ID. No websocket dependency required. After two minutes of interactive waiting, offer “We’re still working—come back shortly” with a recoverable pending item, not a false failure. A canceled/deleted attempt invalidates all remaining jobs and results.

Product allowances are reserved atomically per session. Finalize once on valid feedback; initial system failure releases it. If the first attempt succeeded but retry fails, the original completion/allowance remains and retry can resume within its existing budget. Distinguish system failure from invalid/abusive oversized input and apply documented rate limits. Never make provider failure consume multiple user sessions.

## Audio retention proposal

Raw local/server audio expires within 24 hours by default and earlier on deletion; no audio archive in V1. Confirmed transcripts, valid feedback, and progress persist until user deletion/history-clear. Store a visible privacy summary before upload. These are target behaviors requiring implemented cleanup and vendor-retention review, not claims about configured services. Backups, provider-side retention, deletion time limits, and retained billing records must be finalized before release. A recurring cleanup job must prove it removes expired raw/TTS objects, not merely their database references.
