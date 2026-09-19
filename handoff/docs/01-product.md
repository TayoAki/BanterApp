# Product specification

## Confirmed direction

marshmemos is a Duolingo-style banter-learning app. Users learn the ten supplied frameworks, speak in response to daily prompts, review a transcription, receive specific ratings/feedback, get a reworked version, listen to it, and retry. The user requested close, strict framework adherence and verbatim source examples in AI planning. This handoff is intended for Claude Code or another coding agent to build the entire application.

## Proposed implementation defaults

Adult English-language pilot on iOS and Android. Inclusive everyday/dating scenarios with fictional adults; do not collect dating histories. Expo/React Native with TypeScript, Supabase Auth/Postgres/private storage, a Node server worker for audio/AI jobs, and RevenueCat for native store entitlements. Use email one-time-code sign-in initially. These are selected planning defaults, not provisioned services. Claude Code is the builder; it need not be the runtime model provider.

Start with a server-configured OpenAI adapter for transcription and speech synthesis, and a configurable schema-capable evaluator/rewriter. Keep model IDs in server configuration and benchmark before fixing them. No specific evaluator model or provider cost is assumed. The core learning loop uses sequential short recordings rather than a continuously listening realtime voice agent.

## Main journey

Guest reads one sample lesson and sees the three practice targets. Sign in to save voice practice. Today presents a reviewed prompt and its target framework. The learner taps Start speaking, grants microphone access if needed, records 30–60 seconds with a 90-second hard cap, stops, and chooses Use recording. The server transcribes. The learner checks and optionally edits the transcript, then requests feedback. The server evaluates that exact revision. The learner sees evidence for each criterion, one strength, and one next improvement; opens a fact-preserving rewrite; optionally plays the synthetic voice; records a retry; and sees a comparison and next review.

Recording duration is guidance, not a grading criterion. A short meaningful response can pass. Silence should lead to a recovery message rather than a bad conversational score. Transcription correction itself does not earn improvement credit.

## V1 scope

Ten framework units with Notice, Build, and Transfer lesson seeds; 30 reviewed daily prompt candidates; Today, Learn, Progress; recording and transcript review; criterion feedback; rewrite and TTS; one guided retry per session; due-skill review; three-exchange optional roleplay; account/session lifecycle; local reminder opt-in; private history; report feedback; one optional monthly paid plan; deletion; operational monitoring and release preparation.

Out of scope: public feeds, messaging real people, video, contact imports, voice cloning, always-on listening, accent judging, audio emotion inference, clinical/social-anxiety treatment, creator payouts, leaderboards, and unrestricted companion chat. No claim that an AI score predicts attraction or real-world social success.

## Daily assignment and curriculum

Use order F01, F02, F05, F06, F03, F10, F08, F07, F11, F12. All source IDs stay stable. New users start with an F01 practice; the mockup's F02 is a returning learner fixture. On the first authenticated Today read, atomically create/get one assignment keyed by user and local practice date. Select the most overdue learned skill; otherwise the next unlocked unit; otherwise the least-recently-practiced learned skill. Break ties by curriculum order, then stable prompt ID. Prefer a prompt not used in the last seven practice days, falling back to the least recently used eligible prompt if necessary.

Do not regenerate a daily prompt on each launch or use the model to select entitlement/curriculum state. Persist prompt ID/version and rubric version with the assignment. An existing day's assignment survives timezone changes. Use the timezone effective at assignment creation; a changed timezone applies to the next new practice date. Add a server abuse guard against repeated timezone changes creating multiple paid/free allowances. Billing/AI allowance windows use UTC independently of the daily-learning date.

Optional prompt personalization happens offline or in a reviewed catalog pipeline, not as an unreviewed daily production task. Different user contexts must not alter the skill being tested. The 30 seed prompts are provided as draft content, not a claim of a validated 30-day course.

## Progress

Lesson completion: one honest usable attempt with valid feedback; fixed XP once per lesson version. Proposed +10 completion XP; retries do not farm XP. Practice-fit score comes from validated criterion scores, not the model's self-reported total. Show source-framework subtotal separately when an exercise adds a target.

Mastery: two unassisted qualifying attempts on different prompts, one at least 24 hours after the other, with no source-copy behavior, all source-rule criteria at least 2/3, clear boundary gate, and no low-confidence result. A guided retry can improve the display but never independently completes this mastery requirement. Call states New, Developing, Ready, Review due. Treat numerical scores as coaching estimates.

Review intervals: 1, 3, 7, 14 days after successful independent review; a miss returns to next-day review. Maximum three due items surfaced by default. These are pilot heuristics to test, not scientifically validated schedules. Streak counts one server-confirmed practice completion per chosen local day; no penalty mechanic or paid streak repair.

## Reminder behavior

After the first completed practice, offer a local daily reminder at a user-chosen time. Permission denial leaves the app usable. Use generic lock-screen copy: “Your marshmemos practice is ready.” Do not include transcripts, scores, or sensitive context. Tapping opens Today; preserve destination through sign-in. Reschedule on time/timezone preference changes and cancel on opt-out/sign-out/deletion. Check OS notification permission each time settings is opened. Local notification delivery is OS-controlled and not guaranteed. User must not need an external automation service for in-app reminders.

## Proposed free/paid limits

Free: all approved framework explanations, authored recognition lessons, progress, and one voice practice session per UTC day. Pro: ten sessions per UTC day plus mixed-skill practice. One session includes initial recording, one corrected transcript submission/reassessment, one guided recording retry, one rewrite per evaluated attempt, and one generated playback asset per rewrite. Replaying an existing asset is free. Bound provider retries separately. A roleplay session has at most three learner recordings and three partner replies, one session-end evaluation, and one targeted retry; reserve its larger resource envelope atomically. Show allowance and scope before starting. Prices/store products remain unset until owner choice; do not invent prices in production.

Failed system jobs release unused session reservations. Costs already incurred by a provider are operational cost, not a justification for silently charging a second product allowance. Resuming the same failed attempt uses the same logical key. Extra practice beyond a purchased daily cap is a clear limit, not a paywall pretending to provide unlimited usage.

## First measurable product test

Can a new learner complete record → verified transcript → targeted feedback → truthful rewrite playback → retry within a short session, then reproduce the skill on a new prompt the next day? Measure activation, successful audio pipeline rate, retry improvement, unassisted transfer, seven-day return, feedback-report rate, and actual cost per completed session. Use explicit eligible cohorts and report sample sizes. The mockups contain fictional data.
