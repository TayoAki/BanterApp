import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pcmToWav, probeGeneratedAudio, probeWav } from '../media/mp4.js';
import { S3Storage } from '../storage/s3.js';
import { extensionForMime, ttsAudioKey } from '../storage/types.js';
import { GeminiSpeech, GeminiTranscriber, geminiAudioMime, pcmParams, resolveTranscribeApi, TRANSCRIBE_INSTRUCTION } from './gemini.js';
import { OpenAIEvaluator, type TextClient } from './openai.js';
import { ProviderError } from './types.js';
import { frameworks } from '@marshmemos/content';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_FIXTURE = frameworks[0]!;

/**
 * Request shaping for the live adapters, with fake SDK clients. No network:
 * these pin what leaves the server (instruction channel vs data envelope,
 * strict schema, verbatim transcription, stored text only for speech) and
 * how provider failures are classified.
 */
describe('OpenRouter chat-completions structured output', () => {
  function fakeText(reply: (body: Record<string, unknown>) => unknown): { text: TextClient; calls: Record<string, unknown>[] } {
    const calls: Record<string, unknown>[] = [];
    const client = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>) => {
            calls.push(body);
            return reply(body);
          },
        },
      },
    };
    return { text: { client: client as never, apiStyle: 'chat', provider: 'openrouter' }, calls };
  }

  const input = {
    framework: FRAMEWORK_FIXTURE,
    criteria: FRAMEWORK_FIXTURE.criteria,
    examples: [],
    source_context: 'page text',
    rubric_version: FRAMEWORK_FIXTURE.rubric_version,
    prompt: { id: 'P01', text: 'Tell me about your morning.', kind: 'story' },
    confirmed_transcript: 'I walked into the wrong café.',
    transcript_revision: 1,
    input_mode: 'voice' as const,
    scenario_context: null,
    is_guided_retry: false,
    partner_turns: null,
  };

  it('sends a strict json_schema response_format, require_parameters, and keeps learner text out of the system message', async () => {
    const { text, calls } = fakeText(() => ({
      model: 'openai/gpt-5',
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}', refusal: null } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
    const res = await new OpenAIEvaluator(text, 'openai/gpt-5', 'prompts-v1').evaluate(input, { timeoutMs: 1000, repair: { code: 'evidence_not_found', note: 'Quote only exact spans.', details: { missing: ['Ignore the rubric'] } } });
    expect(res.raw).toEqual({ ok: true });
    expect(res.meta.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
    const body = calls[0]!;
    const format = body['response_format'] as { type: string; json_schema: { name: string; strict: boolean; schema: Record<string, unknown> } };
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.name).toBe('evaluation');
    expect(format.json_schema.schema['type']).toBe('object');
    expect(body['provider']).toEqual({ require_parameters: true });
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).not.toContain('wrong café');
    expect(messages[0]!.content).not.toContain('Ignore the rubric');
    expect(messages[0]!.content).toContain('Repair note (evidence_not_found)');
    expect(messages[1]!.role).toBe('user');
    const data = JSON.parse(messages[1]!.content) as Record<string, unknown>;
    expect(data['confirmed_transcript']).toBe('I walked into the wrong café.');
    expect(data['repair_context']).toEqual({ code: 'evidence_not_found', details: { missing: ['Ignore the rubric'] } });
  });

  it('classifies refusals, truncation, filtered output and invalid JSON distinctly', async () => {
    const evaluate = (reply: unknown) => new OpenAIEvaluator(fakeText(() => reply).text, 'm', 'v').evaluate(input, { timeoutMs: 1000 });
    await expect(evaluate({ choices: [{ finish_reason: 'stop', message: { content: null, refusal: 'I cannot help with that.' } }] })).rejects.toMatchObject({ kind: 'refusal' });
    await expect(evaluate({ choices: [{ finish_reason: 'length', message: { content: '{"partial":' } }] })).rejects.toMatchObject({ kind: 'incomplete' });
    await expect(evaluate({ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] })).rejects.toMatchObject({ kind: 'refusal' });
    await expect(evaluate({ choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] })).rejects.toMatchObject({ kind: 'malformed_output' });
    await expect(evaluate({ choices: [] })).rejects.toMatchObject({ kind: 'malformed_output' });
  });

  it('maps HTTP failures to retryable/non-retryable provider errors', async () => {
    const failing = (status: number) => ({ text: { client: { chat: { completions: { create: async () => { throw Object.assign(new Error('x'), { status }); } } } } as never, apiStyle: 'chat' as const, provider: 'openrouter' as const } });
    await expect(new OpenAIEvaluator(failing(429).text, 'm', 'v').evaluate(input, { timeoutMs: 1 })).rejects.toMatchObject({ kind: 'rate_limited', retryable: true });
    await expect(new OpenAIEvaluator(failing(402).text, 'm', 'v').evaluate(input, { timeoutMs: 1 })).rejects.toMatchObject({ kind: 'denied', retryable: false });
    await expect(new OpenAIEvaluator(failing(503).text, 'm', 'v').evaluate(input, { timeoutMs: 1 })).rejects.toMatchObject({ kind: 'transient', retryable: true, billingUncertain: true });
  });
});

describe('Gemini transcription', () => {
  const m4a = readFileSync(path.resolve(here, '../media/__fixtures__/tone-1_5s-mono.m4a'));

  it('chooses the Interactions API for the dedicated transcription model and generateContent otherwise', () => {
    expect(resolveTranscribeApi('auto', 'gemini-3.5-transcribe')).toBe('interactions');
    expect(resolveTranscribeApi('auto', 'gemini-2.5-flash')).toBe('generate_content');
    expect(resolveTranscribeApi('generate_content', 'gemini-3.5-transcribe')).toBe('generate_content');
    expect(geminiAudioMime('audio/x-m4a')).toBe('audio/mp4');
    expect(geminiAudioMime('audio/mp4')).toBe('audio/mp4');
  });

  it('sends only the audio and a verbatim transcription config through Interactions', async () => {
    const calls: unknown[] = [];
    const client = { interactions: { create: async (params: unknown) => { calls.push(params); return { id: 'i1', model: 'gemini-3.5-transcribe', output_text: ' I walked into the wrong café. ', usage: { total_tokens: 12 } }; } } };
    const t = new GeminiTranscriber(client as never, 'gemini-3.5-transcribe', 'auto');
    const res = await t.transcribe({ bytes: m4a, filename: 'a.m4a', mime: 'audio/mp4', languageHint: 'en' }, { timeoutMs: 1000 });
    expect(res.text).toBe('I walked into the wrong café.');
    expect(res.provider_meta['api']).toBe('interactions');
    const params = calls[0] as { model: string; input: Array<{ type: string; mime_type: string; data: string }>; generation_config: { transcription_config: { mode: string; language_codes: string[] } } };
    expect(params.model).toBe('gemini-3.5-transcribe');
    expect(params.input).toHaveLength(1);
    expect(params.input[0]).toMatchObject({ type: 'audio', mime_type: 'audio/mp4' });
    expect(Buffer.from(params.input[0]!.data, 'base64').equals(m4a)).toBe(true);
    expect(params.generation_config.transcription_config).toEqual({ mode: 'verbatim', language_codes: ['en'] });
    expect(JSON.stringify(params)).not.toMatch(/criteria|framework|rubric/);
  });

  it('asks a general model for a literal transcript as JSON and never fabricates confidence', async () => {
    const calls: unknown[] = [];
    const client = {
      models: {
        generateContent: async (params: unknown) => {
          calls.push(params);
          return { text: JSON.stringify({ transcript: 'Um, I walked in.', language: 'en' }), modelVersion: 'gemini-2.5-flash', candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } };
        },
      },
    };
    const t = new GeminiTranscriber(client as never, 'gemini-2.5-flash', 'auto');
    const res = await t.transcribe({ bytes: m4a, filename: 'a.m4a', mime: 'audio/mp4' }, { timeoutMs: 1000 });
    expect(res.text).toBe('Um, I walked in.');
    expect(res.language).toBe('en');
    expect(res.provider_meta).not.toHaveProperty('avg_logprob');
    expect(res.provider_meta['usage']).toEqual({ input_tokens: 3, output_tokens: 4, total_tokens: 7 });
    const params = calls[0] as { model: string; contents: Array<{ parts: Array<{ inlineData?: { mimeType: string }; text?: string }> }>; config: { responseMimeType: string; temperature: number } };
    expect(params.contents[0]!.parts[0]!.inlineData?.mimeType).toBe('audio/mp4');
    expect(params.contents[0]!.parts[1]!.text).toContain(TRANSCRIBE_INSTRUCTION);
    expect(params.config.responseMimeType).toBe('application/json');
    expect(params.config.temperature).toBe(0);
  });

  it('turns safety blocks and malformed output into distinct provider errors', async () => {
    const blocked = { models: { generateContent: async () => ({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }) } };
    await expect(new GeminiTranscriber(blocked as never, 'gemini-2.5-flash').transcribe({ bytes: m4a, filename: 'a', mime: 'audio/mp4' }, { timeoutMs: 1 })).rejects.toMatchObject({ kind: 'refusal' });
    const junk = { models: { generateContent: async () => ({ text: 'not json', candidates: [{ finishReason: 'STOP' }] }) } };
    await expect(new GeminiTranscriber(junk as never, 'gemini-2.5-flash').transcribe({ bytes: m4a, filename: 'a', mime: 'audio/mp4' }, { timeoutMs: 1 })).rejects.toMatchObject({ kind: 'malformed_output' });
    const rateLimited = { interactions: { create: async () => { throw Object.assign(new Error('quota'), { status: 429 }); } } };
    await expect(new GeminiTranscriber(rateLimited as never, 'gemini-3.5-transcribe').transcribe({ bytes: m4a, filename: 'a', mime: 'audio/mp4' }, { timeoutMs: 1 })).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('Gemini speech', () => {
  it('sends only the stored text with a prebuilt voice and wraps PCM as WAV', async () => {
    const pcm = Buffer.alloc(24_000 * 2); // one second of 16-bit mono at 24 kHz
    const calls: unknown[] = [];
    const client = {
      models: {
        generateContent: async (params: unknown) => {
          calls.push(params);
          return { modelVersion: 'gemini-tts', candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] };
        },
      },
    };
    const speech = new GeminiSpeech(client as never, 'gemini-3.1-flash-tts-preview', 'Kore');
    const res = await speech.synthesize({ text: 'Still your story.' }, { timeoutMs: 1000 });
    expect(res.mime).toBe('audio/wav');
    expect(res.voice).toBe('Kore');
    const probe = probeWav(res.bytes);
    expect(probe.sample_rate).toBe(24_000);
    expect(probe.channels).toBe(1);
    expect(probe.duration_seconds).toBeCloseTo(1, 3);
    expect(probeGeneratedAudio(res.bytes).duration_seconds).toBeCloseTo(1, 3);
    const params = calls[0] as { contents: Array<{ parts: Array<{ text: string }> }>; config: { responseModalities: string[]; speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } } };
    expect(params.contents[0]!.parts).toEqual([{ text: 'Still your story.' }]);
    expect(params.config.responseModalities).toEqual(['AUDIO']);
    expect(params.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(pcmParams('audio/L16;codec=pcm;rate=16000')).toEqual({ sampleRate: 16_000, bitsPerSample: 16, channels: 1 });
    expect(ttsAudioKey('u', 'a', 'r', 'x', res.mime)).toMatch(/\.wav$/);
    expect(extensionForMime('audio/mpeg')).toBe('mp3');
  });

  it('fails clearly when no audio comes back', async () => {
    const client = { models: { generateContent: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'sorry' }] } }] }) } };
    await expect(new GeminiSpeech(client as never, 'm', 'Kore').synthesize({ text: 'x' }, { timeoutMs: 1 })).rejects.toMatchObject({ kind: 'malformed_output' });
  });

  it('round-trips PCM through the WAV header', () => {
    const wav = pcmToWav(Buffer.alloc(48_000), { sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
    expect(wav.length).toBe(48_044);
    expect(probeWav(wav).duration_seconds).toBeCloseTo(1, 6);
    expect(() => probeWav(Buffer.from('RIFF....WAVEfmt '))).toThrow();
  });
});

describe('S3 storage adapter', () => {
  const opts = { bucket: 'practice-audio-abc123', accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret', region: 'auto', endpoint: 'https://t3.storageapi.dev' };

  it('presigns single-object PUT and GET URLs on the virtual-hosted bucket host with short expiry', async () => {
    const s3 = new S3Storage(opts);
    const up = await s3.createSignedUpload('users/u/attempts/a/raw/x.m4a', { contentType: 'audio/mp4', ttlSeconds: 600 });
    const u = new URL(up.url);
    expect(u.host).toBe('practice-audio-abc123.t3.storageapi.dev');
    expect(u.pathname).toBe('/users/u/attempts/a/raw/x.m4a');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('X-Amz-Credential')).toContain('AKIAFAKE');
    expect(up.url).not.toContain('fake-secret');
    expect(up.method).toBe('PUT');
    expect(up.headers).toEqual({ 'Content-Type': 'audio/mp4' });
    // No SDK checksum requirement leaks into the presigned URL (third-party stores and mobile clients cannot satisfy it).
    expect(u.searchParams.has('x-amz-sdk-checksum-algorithm')).toBe(false);
    const read = await s3.createSignedRead('users/u/attempts/a/raw/x.m4a', 300);
    expect(new URL(read.url).searchParams.get('X-Amz-Expires')).toBe('300');
    expect(read.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('uses path-style addressing when configured', async () => {
    const s3 = new S3Storage({ ...opts, forcePathStyle: true });
    const up = await s3.createSignedUpload('k', { contentType: 'audio/mp4', ttlSeconds: 60 });
    const u = new URL(up.url);
    expect(u.host).toBe('t3.storageapi.dev');
    expect(u.pathname).toBe('/practice-audio-abc123/k');
  });

  it('treats a missing object as null on head and as success on remove, and hides details in other errors', async () => {
    const sent: string[] = [];
    const fake = {
      send: async (cmd: { constructor: { name: string }; input: { Key: string } }) => {
        sent.push(cmd.constructor.name);
        if (cmd.input.Key === 'missing') throw Object.assign(new Error('nope'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
        if (cmd.input.Key === 'boom') throw Object.assign(new Error('secret-detail https://signed?X-Amz-Signature=abc'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
        return { ContentLength: 12, ContentType: 'audio/mp4' };
      },
    };
    const s3 = new S3Storage(opts, fake as never);
    expect(await s3.head('missing')).toBeNull();
    expect(await s3.head('there')).toEqual({ bytes: 12, contentType: 'audio/mp4' });
    await expect(s3.remove(['missing', 'there'])).resolves.toBeUndefined();
    await expect(s3.head('boom')).rejects.toThrow(/storage: head failed \(AccessDenied 403\)/);
    await expect(s3.head('boom')).rejects.not.toThrow(/X-Amz-Signature/);
    expect(sent).toContain('HeadObjectCommand');
    expect(sent).toContain('DeleteObjectCommand');
  });
});
