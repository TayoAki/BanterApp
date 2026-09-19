# marshmemos repository instructions

This repository implements the marshmemos mobile app from the build handoff in `handoff/`.
`handoff/` is the immutable specification packet (source PDFs, corpus, rubrics, prompts,
contracts, fixtures, design boards, docs). Read `handoff/CLAUDE.md`, `handoff/docs/01-product.md`,
`handoff/docs/02-framework-engine.md` and `PLAN.md` (root, living status) before changing behavior.
All invariants in `handoff/CLAUDE.md` apply here; the notes below say where each lives in code.

## Layout

| Path | Purpose |
|---|---|
| `apps/mobile` | Expo SDK 57 / React Native 0.86 app (expo-router, expo-audio, expo-notifications, RevenueCat). `src/app` routes, `src/lib` clients/state, `src/components` UI. |
| `apps/server` | Node 22 API (`src/entry/api.ts`, Hono) and durable worker (`src/entry/worker.ts`). Domain logic in `src/domain`, job handlers in `src/worker`, provider adapters in `src/providers`, storage in `src/storage`. |
| `packages/contracts` | Shared types, the four JSON Schemas (byte-identical to `handoff/contracts`), Ajv validation, semantic checks, server totals, rewrite fact checks, API DTOs. Mobile imports `@marshmemos/contracts/api` and `/types` only. |
| `packages/content` | Bundled copies of `handoff/content/*.json` (hash-checked), typed loader, integrity checks, publication manifests, curriculum order, authored Notice recognition keys (draft). |
| `supabase/migrations` | Schema, SQL functions (allowance reservation, job claim/lease, timezone guard), RLS/grants, private bucket. `supabase/local/auth_stub.sql` is for plain Postgres only. |
| `tests` | Cross-cutting checks (handoff validator, repo shape, env example). |

## Commands

```bash
pnpm install                     # Node >= 22.12, pnpm 10 (hoisted linker)
pnpm typecheck && pnpm test      # every package
TEST_DATABASE_URL=postgres://... pnpm test:db   # migrations, RLS, quota, jobs, full API journey
pnpm content:validate            # 407 content integrity checks incl. PDF hashes
pnpm server:api / pnpm server:worker            # needs apps/server/.env (see .env.example)
pnpm mobile                      # expo start --dev-client (native dev build required for audio/purchases)
```

## Rules that are enforced in code (keep them that way)

- Model output never sets totals, XP, mastery, quota, roles or access: `packages/contracts/src/evaluation.ts` computes totals; `apps/server/src/domain/progress.ts` derives progress; `entitlements.ts` grants only from verified provider state.
- Every evaluation is validated by schema plus semantics (assigned criteria exactly once, framework/revision match, evidence substrings, source IDs from the framework) before it is persisted (`apps/server/src/worker/pipeline.ts`).
- Rewrites pass lexical fact checks, deterministic entity/number signals, an independent verifier, and a separate re-evaluation; failures regenerate once, then return `needs_detail` (`worker/handlers.ts`).
- Source quotes render from corpus records only (`packages/content`, `SourceQuote.tsx`). Never paraphrase them. F04/F09 do not exist.
- Identity comes from the verified bearer token (`apps/server/src/auth/verify.ts`); ownership is checked on every record, job, asset and signed URL; composite `(id, user_id)` foreign keys back this in SQL.
- Production startup refuses fixture providers, fixture auth, local storage, the development content manifest and demo entitlements (`apps/server/src/config.ts`).
- Microphone use is user-initiated and foreground-only; nothing uploads before "Use recording" (`apps/mobile/src/app/practice/[session]/record.tsx`, `review-recording.tsx`).
- Content is draft until listed in `packages/content/src/publication/production.json`; the development manifest is a labeled local preview.

## Working conventions

- Keep `handoff/` unchanged except for nothing; update the root `PLAN.md` with observed results and exact blockers.
- Run `pnpm typecheck`, `pnpm test` and the DB suite before pushing. Do not weaken RLS, the config guards, or the semantic validators to make a test pass.
- Provider/model IDs are configuration (`.env.example`). No provider is "connected" until a live call is recorded in `PLAN.md`.
- Never log tokens, connection strings, audio, transcripts or full provider payloads (`apps/server/src/logger.ts` redaction is defense in depth, not permission).
