# Design implementation specification

Brand: lowercase **marshmemos**. Voice: friendly, specific, adult, encouraging without inflated praise. Tagline: “A little practice. A little more you.” Use the two supplied PNG boards as visual references for the six central screens. All numbers, transcripts, waveform shapes, and progress in those boards are fictional fixtures. Use real native controls and text, not screenshots as the interface.

`design/tokens.json` supplies exact color/type/spacing values. Use system typography with native rounded variants where available. Body text scales from 17; never shrink below readable size to match an image. Minimum touch target 48 logical units, safe-area padding, scrollable content, announced status changes, non-color state cues, reduced-motion support. Validate contrast numerically and on-device. Decorative marshmallow speech-bubble character is optional; it must not obstruct copy or become a required unprovided production asset. Start with a simple original vector illustration; generated UI-board artwork is a reference, not a separately licensed stock asset claim.

## Routes

| Route | Content and main action | Required states |
|---|---|---|
| `/welcome` | Brand/promise, adult-audience notice, Try a lesson / Sign in | New, returning, unsupported audience |
| `/auth` | Email/code, continue saved destination | Send, invalid/expired, rate-limited, canceled, success |
| `/onboarding` | Goal, experience, optional social/dating context, short audio privacy explanation | Skipped optional fields, save failure |
| `/(tabs)/today` | Daily framework, prompt, three visible targets, allowance, Start speaking | New, ready, pending session, completed, offline, no published prompt |
| `/(tabs)/learn` | Ten-unit path, Notice/Build/Transfer lessons, source cards | Loading, no progress, current, completed, unavailable draft |
| `/lesson/:id` | Principle, exact source example, editorial label, recognition/build task | Expand/scroll quote, quiz feedback, retry, failure |
| `/practice/:session/record` | Prompt, timer/meter, stop, discard, typing fallback | Permission, recording, interruption, no audio, hard limit |
| `/practice/:session/review-recording` | Play, Use recording, Record again, Discard | Ready, missing file, uploading, retry |
| `/attempt/:id/transcript` | Original playback, editable text, confirmation | Transcribing, review, editing/keyboard, unsupported language, failure |
| `/attempt/:id/feedback` | Criterion scores/evidence, source subtotal, one strength/improvement | Evaluating, scored, uncertain, revise, no usable input, reported |
| `/rewrite/:id` | Suggested text, exact saved TTS, changes, own-words retry | Generating, ready, needs detail, validating, rejected, playback failed |
| `/session/:id/comparison` | First attempt and guided retry, criterion deltas, next review | Ready, no comparable result, stale revision, unavailable retry |
| `/(tabs)/progress` | Skill states, practices, streak, reviews, history | Empty, active, review due, history deleted |
| `/practice/roleplay` | Context, adult fictional partner, bounded voice turns, finish | Ready, recording/transcribing, partner response, ended, timeout |
| `/upgrade` | Exact store product/period/limits, buy/restore/manage | Loading, unavailable, canceled, pending, active, failed |
| `/settings` | Preferences, reminder, history/data, account, support | Signed in/out, permission denied, saving, deletion pending |

Today, Learn, Progress tabs are the current navigation. Earlier Banter mockups are superseded. Recording/feedback stacks hide tabs and expose Back with draft preservation or a clear discard decision when needed. Back never silently loses a completed take.

## Six reference screens and exact production copy

1. **Today:** “What’s your story today?”; F02 fixture title “Make the ordinary interesting.”; full prompt from `F02-P01`; three target labels from content JSON; “30–60 seconds”; “Start speaking”. The image shortens the prompt: production uses the complete seed text including the invitation target.
2. **Recording:** “Go on. We’re listening.”; “Finish recording”; “Recording”; “60 second target · 90 second limit”; “Only records while this screen is open.” That last claim must match implemented app lifecycle behavior.
3. **Transcript:** “Did we hear you right?”; “Edit transcript”; “Your feedback uses the words you confirm.”; “Get my feedback”; “Record again”. Full editable text must remain visible above the keyboard. Confirm button disabled only while blank, unchanged request in flight, or invalid length—not because a user changed the transcription.
4. **Feedback:** “A strong start.” for the provided fixture only; “Practice fit · Framework 2”, 6/9; “Source criteria: 6/6”; “Exercise target: 0/3”. Three criterion labels from config. Evidence from actual transcript. Use “What went well” and “One thing to work on”; “View suggested rewrite”. These exact labels supersede the concept image's shorter “Framework fit” and “Hear a stronger version”. Only a verified improved rewrite can earn a stronger-version label.
5. **Rewrite:** “Still your story. A little more spark.”; “Suggested rewrite”; “Listen”; “AI-generated voice”; “What changed”; “You don’t need to memorize it.”; “Try it in your own words”. If asking for more detail, replace unavailable rewrite/player with the specific question and editable answer path.
6. **Progress:** “Small reps. Real progress.”; “Guided retry · mastery still developing” for a coached comparison; skill badges; reminder time. Numeric changes come from stored comparable evaluations. Never generate graph values to fill space.

## Non-happy paths

Permission denied: “Microphone access is off. You can enable it in Settings or type your practice.” Buttons Open settings / Type instead.

No clear speech: “We couldn’t get a clear transcript. Try another take or type what you said.” No score or failure XP.

Transcription failed: preserve file; “Your recording is saved on this device. Try sending it again.” Show this only if the file exists. If the file expired, explain that honestly.

Evaluation failed: “Your words are saved. Feedback couldn’t finish yet.” Retry same logical job or return later. Never fabricate cached feedback for a different attempt.

Uncertain judgment: “We need a little more context to assess this.” Show one question. Do not display 0/9 as a substitute for uncertainty.

TTS failed: keep rewrite readable; “Audio is unavailable right now.” Retry playback generation; no second practice charge.

Quota used: show exact remaining allowance/UTC reset converted to local time, Continue learning, and optional offer. Finish reading saved feedback without requiring payment.

## Visual verification

Capture actual small-phone and large-text screens, plus microphone-denied, keyboard-open, long-transcript, feedback-uncertain, pending-upload, and playback-failed states. Compare hierarchy/spacing/copy to tokens and reference boards in up to three focused passes. Ensure VoiceOver/TalkBack can start/stop recording and distinguish playback from microphone controls. A static image is not evidence of runtime accessibility.
