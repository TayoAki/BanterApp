import type { ServerConfig } from '../config.js';
import { createFixtureProviders, NoEntitlements } from './fixture.js';
import { createGeminiClient, GeminiSpeech, GeminiTranscriber } from './gemini.js';
import { createOpenAIAudioClient, createTextClient, OpenAIEvaluator, OpenAIPartner, OpenAIRewriter, OpenAISpeech, OpenAITranscriber, OpenAIVerifier } from './openai.js';
import { RevenueCatEntitlements } from './revenuecat.js';
import type { EntitlementProvider, Providers, SpeechSynthesizer, Transcriber } from './types.js';

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

/** Speech-to-text and text-to-speech adapters for the configured audio provider. */
export function createAudioProviders(config: ServerConfig): { transcriber: Transcriber; speech: SpeechSynthesizer } {
  if (config.AUDIO_AI_PROVIDER === 'gemini') {
    const client = createGeminiClient(config);
    return {
      transcriber: new GeminiTranscriber(client, config.TRANSCRIPTION_MODEL, config.AUDIO_AI_TRANSCRIBE_API),
      speech: new GeminiSpeech(client, config.TTS_MODEL, config.TTS_VOICE),
    };
  }
  const client = createOpenAIAudioClient(config);
  return {
    transcriber: new OpenAITranscriber(client, config.TRANSCRIPTION_MODEL),
    speech: new OpenAISpeech(client, config.TTS_MODEL, config.TTS_VOICE),
  };
}

export function createProviders(config: ServerConfig): Providers {
  if (config.PROVIDER_MODE === 'fixture') {
    if (config.isProduction) throw new Error('Fixture providers are forbidden in production');
    return createFixtureProviders({ entitlements: createEntitlementProvider(config) });
  }
  const text = createTextClient(config);
  const audio = createAudioProviders(config);
  const v = config.PROMPT_CONFIG_VERSION;
  return {
    mode: 'live',
    transcriber: audio.transcriber,
    evaluator: new OpenAIEvaluator(text, config.EVALUATION_MODEL, v),
    rewriter: new OpenAIRewriter(text, config.REWRITE_MODEL, v),
    verifier: new OpenAIVerifier(text, config.VERIFIER_MODEL, v),
    partner: new OpenAIPartner(text, config.ROLEPLAY_MODEL, v),
    speech: audio.speech,
    entitlements: createEntitlementProvider(config),
  };
}
