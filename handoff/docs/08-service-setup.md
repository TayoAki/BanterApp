# Service setup and current documentation

Checked 19 September 2026. Verify again against installed versions before coding. These links support integration choices; they are not evidence that services are connected.

| Service | Builder work and required configuration |
|---|---|
| Expo | Create app IDs/signing for iOS/Android; pin compatible SDK/React Native versions; native development builds; microphone permission; foreground audio; notifications; secure token storage; environment-specific callback routes |
| Supabase | Separate development/production projects; email code auth; database migrations/RLS; private media buckets; owner-scoped upload/read issuance; job queue; backup/deletion inventory |
| Worker hosting | Node runtime with sufficient request/job timeouts and media validation tools; database connectivity; leases; secrets; health checks; cleanup scheduler; monitoring |
| AI provider | Server account/key; transcription, evaluator and speech model availability; model IDs; budget limits; vendor data handling; strict JSON-schema support adapter; fixed prompt/config versions |
| RevenueCat + stores | Bundle/application IDs, sandbox products, Pro mapping, customer identity, webhook auth/config, restore/transfer policy, server reconciliation; production products only after owner choice |
| Support/site | Operator facts and contact, privacy, terms, deletion-request resource, accurate offer/limits; release domains and links |

`expo-audio` handles recording/playback. `expo-notifications` supports local scheduling; configure and test its platform permissions. SDK/OS behavior must be tested on target devices rather than inferred from Expo Go alone. [Audio](https://docs.expo.dev/versions/latest/sdk/audio/), [Notifications](https://docs.expo.dev/versions/latest/sdk/notifications/), [Development builds](https://docs.expo.dev/develop/development-builds/introduction/).

Expo provides a Supabase integration guide. RevenueCat provides Expo installation/testing guidance for native purchases. These do not remove the need for server authorization and tested store setup. [Expo/Supabase](https://docs.expo.dev/guides/using-supabase/), [RevenueCat/Expo](https://www.revenuecat.com/docs/getting-started/installation/expo).

OpenAI's file transcription and TTS guides describe the proposed audio services; `gpt-4o-mini-tts` is a documented speech model candidate. Choose transcription/evaluator IDs after checking account availability and the evaluation suite. Structured outputs constrain schema, but the backend must still handle refusal/incomplete output and validate meaning. [Transcription](https://developers.openai.com/api/docs/guides/speech-to-text), [Speech](https://developers.openai.com/api/docs/guides/text-to-speech), [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## Environment variable contract

Client-public: `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, public platform-specific RevenueCat SDK keys, and environment name. Public variables must never include service-role, model, or webhook secrets.

Server-only: `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AI_API_KEY`, `TRANSCRIPTION_MODEL`, `EVALUATION_MODEL`, `REWRITE_MODEL`, `TTS_MODEL`, `TTS_VOICE`, billing server credential and webhook verification configuration, monitoring configuration, prompt-config version, storage bucket IDs, deployment environment. Names are interface proposals; adapt to existing tooling without weakening secrecy.

Include `.env.example` with empty secret placeholders in the implemented repository. Production startup validates required configuration and rejects fixture providers. Never log connection strings, bearer tokens, uploaded audio, transcripts, or full provider/billing payloads. User dashboard tasks that cannot be automated should be listed by service/action; ask for configuration through normal secure setup, not secret values in chat.

No install/scaffold command in this packet pins an unverified SDK combination. The builder must inspect its environment, choose compatible versions from current official docs, record them in a lockfile, and report actual build checks. All credentials, pricing, operator identity, supported storefronts, and provider retention details remain unconfigured.

The supplied JSON Schemas are the local authoritative response contracts. Translate only unsupported schema keywords for the chosen provider's strict-output subset while retaining all original validation in the backend. Handle refusals, incomplete responses and malformed outputs as distinct results, never as successful evaluations. Use a maintained local schema validator in production.
