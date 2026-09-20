import { GoogleGenAI, Modality, type GenerateContentConfig, type GenerateContentResponse } from '@google/genai';
import type { ServerConfig } from '../config.js';
import { pcmToWav } from '../media/mp4.js';
import { classifyProviderError as classify } from './classify.js';
import { ProviderError, type SpeechResult, type SpeechSynthesizer, type Transcriber, type TranscriptionResult } from './types.js';

/**
 * Google Gemini adapters for the two audio roles.
 *
 * - Transcription: either the dedicated transcription model through the
 *   Interactions API (`gemini-3.5-transcribe`, verbatim mode) or a general
 *   multimodal model through generateContent with a literal-transcription
 *   instruction and a JSON response schema. `AUDIO_AI_TRANSCRIBE_API`
 *   selects the surface; `auto` picks Interactions for models whose ID
 *   contains "transcribe". Nothing about frameworks, examples or grading is
 *   sent with the audio.
 * - Speech: a Gemini TTS model through generateContent with
 *   `responseModalities: [AUDIO]` and a prebuilt voice. The API returns raw
 *   16-bit PCM; it is wrapped as WAV so every player can decode it.
 *
 * Gemini 3.8 Live (`gemini-3.8-live`) is a realtime speech-to-speech model on
 * the Live API (WebSocket). It does not fit the V1 sequential pipeline
 * (record → confirm transcript → evaluate → rewrite → play) and is not used.
 */

export type TranscribeApi = 'auto' | 'interactions' | 'generate_content';

export const TRANSCRIBE_INSTRUCTION =
  'Transcribe the speech in the attached audio literally, in the language spoken. Keep the speaker’s exact words, including fillers, false starts and self-corrections; do not paraphrase, summarize, translate, correct grammar or add commentary. If nothing intelligible is said, return an empty transcript.';

/** Gemini's inline-audio MIME vocabulary; M4A/AAC-in-MP4 uploads are sent as audio/mp4 (accepted alongside audio/m4a). */
export function geminiAudioMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  if (m === 'audio/x-m4a' || m === 'audio/m4a') return 'audio/mp4';
  if (m === 'audio/mp3') return 'audio/mpeg';
  return m;
}

export function createGeminiClient(config: ServerConfig, fetchImpl?: typeof fetch): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: config.audioApiKey ?? '',
    httpOptions: {
      ...(config.AUDIO_AI_BASE_URL ? { baseUrl: config.AUDIO_AI_BASE_URL } : {}),
      ...(fetchImpl ? { fetch: fetchImpl as never } : {}),
      // Retries are the worker's job, with recorded budgets.
      retryOptions: { attempts: 1 },
    },
  });
}

export function resolveTranscribeApi(api: TranscribeApi, model: string): 'interactions' | 'generate_content' {
  if (api !== 'auto') return api;
  return /transcribe/i.test(model) ? 'interactions' : 'generate_content';
}

interface TranscriptShape {
  transcript?: unknown;
  language?: unknown;
}

export class GeminiTranscriber implements Transcriber {
  readonly api: 'interactions' | 'generate_content';
  constructor(
    private readonly client: GoogleGenAI,
    readonly model: string,
    api: TranscribeApi = 'auto',
  ) {
    this.api = resolveTranscribeApi(api, model);
  }

  async transcribe(input: { bytes: Buffer; filename: string; mime: string; languageHint?: string }, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<TranscriptionResult> {
    if (input.bytes.length === 0) throw new ProviderError('bad_input', 'Empty audio.');
    const started = Date.now();
    const mime = geminiAudioMime(input.mime);
    const data = input.bytes.toString('base64');
    return this.api === 'interactions' ? this.viaInteractions(data, mime, input.languageHint, opts, started) : this.viaGenerateContent(data, mime, input.languageHint, opts, started);
  }

  private async viaInteractions(data: string, mime: string, languageHint: string | undefined, opts: { timeoutMs: number; signal?: AbortSignal }, started: number): Promise<TranscriptionResult> {
    let res: { output_text?: string | undefined; model?: string | undefined; status?: unknown; usage?: unknown; outputs?: unknown; errors?: unknown };
    try {
      res = (await this.client.interactions.create(
        {
          model: this.model,
          input: [{ type: 'audio', data, mime_type: mime }],
          generation_config: {
            transcription_config: {
              mode: 'verbatim',
              ...(languageHint ? { language_codes: [languageHint] } : {}),
            },
          },
        } as never,
        { timeout: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) } as never,
      )) as never;
    } catch (err) {
      throw classify(err);
    }
    if (Array.isArray(res.errors) && res.errors.length > 0) throw new ProviderError('transient', 'Transcription interaction reported an error.', { billingUncertain: true });
    const text = typeof res.output_text === 'string' ? res.output_text : collectText(res.outputs);
    if (text === null) throw new ProviderError('malformed_output', 'Transcription returned no text.');
    return {
      text: text.trim(),
      language: languageHint ?? null,
      duration_seconds: null,
      provider_meta: { model: res.model ?? this.model, api: 'interactions', usage: res.usage ?? null, latency_ms: Date.now() - started },
      model: res.model ?? this.model,
    };
  }

  private async viaGenerateContent(data: string, mime: string, languageHint: string | undefined, opts: { timeoutMs: number; signal?: AbortSignal }, started: number): Promise<TranscriptionResult> {
    const config: GenerateContentConfig = {
      temperature: 0,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: { transcript: { type: 'string' }, language: { type: ['string', 'null'] } },
        required: ['transcript', 'language'],
        additionalProperties: false,
      },
      httpOptions: { timeout: opts.timeoutMs },
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
    };
    let res: GenerateContentResponse;
    try {
      res = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data } }, { text: languageHint ? `${TRANSCRIBE_INSTRUCTION} The speaker is expected to use language code "${languageHint}".` : TRANSCRIBE_INSTRUCTION }] }],
        config,
      });
    } catch (err) {
      throw classify(err);
    }
    assertNotBlocked(res);
    const text = res.text;
    if (!text) throw new ProviderError('malformed_output', 'Transcription returned no text.');
    let parsed: TranscriptShape;
    try {
      parsed = JSON.parse(text) as TranscriptShape;
    } catch {
      throw new ProviderError('malformed_output', 'Transcription output was not valid JSON.');
    }
    if (typeof parsed.transcript !== 'string') throw new ProviderError('malformed_output', 'Transcription output lacked a transcript field.');
    const candidate = res.candidates?.[0];
    const avg = (candidate as { avgLogprobs?: unknown } | undefined)?.avgLogprobs;
    return {
      text: parsed.transcript.trim(),
      language: typeof parsed.language === 'string' ? parsed.language : languageHint ?? null,
      duration_seconds: null,
      provider_meta: {
        model: res.modelVersion ?? this.model,
        api: 'generate_content',
        // Provider-supplied uncertainty only when the API returns it; never fabricated.
        ...(typeof avg === 'number' ? { avg_logprob: avg } : {}),
        finish_reason: candidate?.finishReason ?? null,
        usage: usageOf(res),
        latency_ms: Date.now() - started,
      },
      model: res.modelVersion ?? this.model,
    };
  }
}

function collectText(outputs: unknown): string | null {
  if (!Array.isArray(outputs)) return null;
  const parts: string[] = [];
  for (const step of outputs as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>) {
    if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const c of step.content) if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
  }
  return parts.length > 0 ? parts.join('') : null;
}

function usageOf(res: GenerateContentResponse): Record<string, unknown> | null {
  const u = res.usageMetadata;
  if (!u) return null;
  return { input_tokens: u.promptTokenCount ?? null, output_tokens: u.candidatesTokenCount ?? null, total_tokens: u.totalTokenCount ?? null };
}

function assertNotBlocked(res: GenerateContentResponse): void {
  const block = res.promptFeedback?.blockReason;
  if (block) throw new ProviderError('refusal', `Model blocked the request (${String(block)}).`);
  const finish = res.candidates?.[0]?.finishReason;
  if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST' || finish === 'SPII') throw new ProviderError('refusal', `Model stopped for ${finish}.`);
  if (finish === 'MAX_TOKENS') throw new ProviderError('incomplete', 'Model output incomplete (max tokens).');
  if (finish === 'RECITATION' || finish === 'LANGUAGE' || finish === 'MALFORMED_FUNCTION_CALL') throw new ProviderError('malformed_output', `Model stopped for ${finish}.`);
}

/** Parses `audio/L16;codec=pcm;rate=24000` style MIME types into PCM parameters. */
export function pcmParams(mime: string | undefined): { sampleRate: number; bitsPerSample: number; channels: number } {
  const m = (mime ?? '').toLowerCase();
  const rate = /rate=(\d+)/.exec(m);
  const bits = /l(\d+)/.exec(m.split(';')[0] ?? '');
  return { sampleRate: rate ? Number(rate[1]) : 24_000, bitsPerSample: bits ? Number(bits[1]) : 16, channels: 1 };
}

export class GeminiSpeech implements SpeechSynthesizer {
  constructor(
    private readonly client: GoogleGenAI,
    readonly model: string,
    readonly voice: string,
  ) {}

  async synthesize(input: { text: string; voice?: string }, opts: { timeoutMs: number }): Promise<SpeechResult> {
    const voice = input.voice ?? this.voice;
    let res: GenerateContentResponse;
    try {
      res = await this.client.models.generateContent({
        model: this.model,
        // The stored, validated rewrite text only; no style instructions that could alter the words.
        contents: [{ role: 'user', parts: [{ text: input.text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          httpOptions: { timeout: opts.timeoutMs },
        },
      });
    } catch (err) {
      throw classify(err);
    }
    assertNotBlocked(res);
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    const data = part?.inlineData?.data;
    if (!data) throw new ProviderError('malformed_output', 'Speech response carried no audio.');
    const pcm = Buffer.from(data, 'base64');
    if (pcm.length === 0) throw new ProviderError('malformed_output', 'Empty speech response.');
    const mime = part?.inlineData?.mimeType ?? 'audio/L16;codec=pcm;rate=24000';
    if (/^audio\/(wav|x-wav|wave)/i.test(mime)) return { bytes: pcm, mime: 'audio/wav', model: res.modelVersion ?? this.model, voice };
    if (/^audio\/(mpeg|mp3)/i.test(mime)) return { bytes: pcm, mime: 'audio/mpeg', model: res.modelVersion ?? this.model, voice };
    return { bytes: pcmToWav(pcm, pcmParams(mime)), mime: 'audio/wav', model: res.modelVersion ?? this.model, voice };
  }
}
