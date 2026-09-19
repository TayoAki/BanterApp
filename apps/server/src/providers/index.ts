import type { ServerConfig } from '../config.js';
import { createFixtureProviders, NoEntitlements } from './fixture.js';
import { createOpenAIClient, OpenAIEvaluator, OpenAIPartner, OpenAIRewriter, OpenAISpeech, OpenAITranscriber, OpenAIVerifier } from './openai.js';
import { RevenueCatEntitlements } from './revenuecat.js';
import type { EntitlementProvider, Providers } from './types.js';

export function createEntitlementProvider(config: ServerConfig): EntitlementProvider {
  if (config.BILLING_PROVIDER === 'revenuecat') {
    return new RevenueCatEntitlements({
      secretApiKey: config.REVENUECAT_SECRET_API_KEY!,
      webhookAuth: config.REVENUECAT_WEBHOOK_AUTH!,
      entitlementId: config.REVENUECAT_PRO_ENTITLEMENT_ID,
      environment: config.REVENUECAT_ENVIRONMENT,
    });
  }
  return new NoEntitlements();
}

export function createProviders(config: ServerConfig): Providers {
  if (config.PROVIDER_MODE === 'fixture') {
    if (config.isProduction) throw new Error('Fixture providers are forbidden in production');
    return createFixtureProviders({ entitlements: createEntitlementProvider(config) });
  }
  const client = createOpenAIClient(config);
  const v = config.PROMPT_CONFIG_VERSION;
  return {
    mode: 'openai',
    transcriber: new OpenAITranscriber(client, config.TRANSCRIPTION_MODEL),
    evaluator: new OpenAIEvaluator(client, config.EVALUATION_MODEL, v),
    rewriter: new OpenAIRewriter(client, config.REWRITE_MODEL, v),
    verifier: new OpenAIVerifier(client, config.VERIFIER_MODEL, v),
    partner: new OpenAIPartner(client, config.ROLEPLAY_MODEL, v),
    speech: new OpenAISpeech(client, config.TTS_MODEL, config.TTS_VOICE),
    entitlements: createEntitlementProvider(config),
  };
}
