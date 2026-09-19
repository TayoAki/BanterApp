import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MediaProbeError, probeAudio, probeMp4 } from './mp4.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.join(here, '__fixtures__', name));

describe('probeAudio', () => {
  it('reads duration, codec, channels and sample rate from a real AAC/M4A file', () => {
    const p = probeAudio(fixture('tone-1_5s-mono.m4a'));
    expect(p.container).toBe('mp4');
    expect(p.codec).toBe('mp4a');
    expect(p.channels).toBe(1);
    expect(p.sample_rate).toBe(44100);
    expect(p.duration_seconds).toBeGreaterThan(1.4);
    expect(p.duration_seconds).toBeLessThan(1.7);
    expect(p.audio_tracks).toBe(1);
  });

  it('reports stereo channel count', () => {
    const p = probeAudio(fixture('tone-0_6s-stereo.m4a'));
    expect(p.channels).toBe(2);
    expect(p.duration_seconds).toBeGreaterThan(0.5);
  });

  it('estimates MP3 duration from frames', () => {
    const p = probeAudio(fixture('tone-0_5s.mp3'));
    expect(p.container).toBe('mp3');
    expect(p.duration_seconds).toBeGreaterThan(0.4);
    expect(p.duration_seconds).toBeLessThan(0.7);
  });

  it('rejects a file renamed to .m4a that is not MP4', () => {
    const fake = Buffer.concat([Buffer.from('RIFF....WAVEfmt '), Buffer.alloc(64)]);
    expect(() => probeAudio(fake)).toThrow(MediaProbeError);
    expect(() => probeMp4(fake)).toThrow(/ftyp/);
  });

  it('rejects a truncated MP4 (no moov) instead of guessing a duration', () => {
    const real = fixture('tone-1_5s-mono.m4a');
    const ftyp = real.readUInt32BE(0);
    const truncated = real.subarray(0, ftyp + 8); // ftyp + partial next box
    expect(() => probeMp4(truncated)).toThrow(MediaProbeError);
  });

  it('rejects tiny or empty buffers', () => {
    expect(() => probeAudio(Buffer.alloc(0))).toThrow(MediaProbeError);
    expect(() => probeAudio(Buffer.alloc(10))).toThrow(MediaProbeError);
  });
});
