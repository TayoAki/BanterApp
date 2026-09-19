# Build marshmemos

This is a build handoff, not an implemented application. It contains product decisions, original PDFs, a machine-readable corpus, framework rubrics, 30 daily prompt seeds, 30 lesson seeds, six screen mockups, AI prompts, response schemas, fixtures, and verification instructions.

## How to use with Claude Code

1. Extract this archive into the project workspace. In an existing repository, put the handoff in `handoff/` and preserve its existing `CLAUDE.md`; merge the project-specific instructions instead of overwriting them.
2. Open Claude Code in that workspace and paste the instruction below.
3. Add required service credentials to the project's supported secret mechanism when requested by variable name. Never paste secret values into a chat or commit them.
4. Have the agent work through `PLAN.md`, checking each completed user flow before proceeding. Provider access may block a service test, but should not stop independent implementation.

## Paste this into Claude Code

> Build the entire marshmemos mobile app described in this handoff. Read CLAUDE.md, docs/01-product.md, PLAN.md, and docs/02-framework-engine.md first. Then inspect all referenced contracts, content, prompts, design specifications, and existing repository instructions before implementing each feature. Build for iOS and Android with Expo/React Native, using the proposed stack unless this repository already has a suitable working stack. The core flow is daily speaking prompt → record → transcribe → user confirms transcript → evaluate against explicit framework criteria → fact-preserving rewrite → play AI-generated speech → record a retry → persist progress. Preserve source examples verbatim. Implement backend ownership, durable jobs, failure recovery, reminders, accounts, deletion, and sandbox subscription access as specified. Do not stop at mock screens. Do not claim integrations or device tests work without evidence. Use version-matched official documentation, keep keys server-side, work in complete vertical slices, and update PLAN.md with observed results and exact blockers. Continue until all feasible features and checks are complete. Do not publish or submit to stores as part of this implementation request.

## Reading map

| File | Purpose |
|---|---|
| `CLAUDE.md` | Durable builder instructions and authority order |
| `PLAN.md` | Feature sequence, dependencies, and acceptance gates |
| `docs/01-product.md` | Confirmed scope, daily flow, business assumptions |
| `docs/02-framework-engine.md` | Strict source fidelity, scoring, rewrites, calibration |
| `docs/03-voice-and-jobs.md` | Recording, upload, transcription, playback, retries |
| `docs/04-data-and-api.md` | Tables, constraints, authorization, endpoints |
| `docs/05-design.md` | Routes, exact copy, interaction states, image references |
| `docs/06-accounts-billing-operations.md` | Accounts, paid access, retention, release |
| `docs/07-verification.md` | Device, security, AI quality, and acceptance tests |
| `docs/08-service-setup.md` | Service setup checklist and official documentation |
| `prompts/` | Runtime and authoring prompt templates |
| `content/` | Original source PDFs, corpus, rubrics, prompt and lesson seeds |
| `contracts/` | Strict evaluation and rewrite JSON Schemas |
| `fixtures/` | Consistent example attempt, feedback, and rewrite |
| `design/` | Two image boards containing six screens plus tokens |
| `scripts/validate_handoff.py` | Offline integrity checks for this package |
| `verification/HANDOFF-CHECKS.md` | Checks actually run on this packet |

Source declarations and examples are authoritative for their original wording. Rubrics are explicit teaching interpretations. Photos/images are visual references, not an exact text source. Seed content is marked draft until a curriculum review and rights decision permit publication. The app should support internal draft preview without exposing drafts to public users.

The name is **marshmemos**, lowercase in the UI. The earlier working name Banter is superseded. Name/domain/trademark availability has not been checked. This packet supersedes the earlier text-first plan: voice recording, transcription, playback, daily prompts, and reminders are now V1 requirements.
