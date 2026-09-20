/**
 * Minimal ISO base media (MP4/M4A) probe with no native dependencies.
 * Reads the box tree far enough to report container brand, movie duration,
 * and the audio sample entry (codec, channels, sample rate). Rejects files
 * that are not a well-formed MP4 with a single audio track.
 *
 * Scope: validation of learner uploads before spending provider budget on
 * them. It is not a general-purpose demuxer.
 */

export interface MediaProbe {
  container: 'mp4' | 'mp3';
  brand: string | null;
  duration_seconds: number;
  codec: string | null;
  channels: number | null;
  sample_rate: number | null;
  audio_tracks: number;
  has_video: boolean;
}

export class MediaProbeError extends Error {
  readonly code: 'unsupported_container' | 'malformed' | 'no_audio_track' | 'video_present' | 'too_short';
  constructor(code: MediaProbeError['code'], message: string) {
    super(message);
    this.name = 'MediaProbeError';
    this.code = code;
  }
}

const MP4_BRANDS = new Set(['M4A ', 'isom', 'iso2', 'mp41', 'mp42', 'M4B ', 'avc1', 'iso5', 'iso6', 'qt  ']);

function readBox(buf: Buffer, offset: number, end: number): { type: string; start: number; headerSize: number; size: number } | null {
  if (offset + 8 > end) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString('latin1', offset + 4, offset + 8);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > end) return null;
    const big = buf.readBigUInt64BE(offset + 8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(big);
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset; // box extends to end of file
  }
  if (size < headerSize || offset + size > end) return null;
  return { type, start: offset, headerSize, size };
}

function* boxes(buf: Buffer, start: number, end: number): Generator<{ type: string; start: number; headerSize: number; size: number }> {
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBox(buf, offset, end);
    if (!box) throw new MediaProbeError('malformed', `Malformed box at offset ${offset}.`);
    yield box;
    offset += box.size;
  }
}

function findChild(buf: Buffer, start: number, end: number, type: string) {
  for (const b of boxes(buf, start, end)) if (b.type === type) return b;
  return null;
}

function parseMvhd(buf: Buffer, box: { start: number; headerSize: number; size: number }): number {
  const p = box.start + box.headerSize;
  const version = buf.readUInt8(p);
  if (version === 1) {
    const timescale = buf.readUInt32BE(p + 20);
    const duration = Number(buf.readBigUInt64BE(p + 24));
    if (timescale === 0) throw new MediaProbeError('malformed', 'mvhd timescale is zero.');
    return duration / timescale;
  }
  const timescale = buf.readUInt32BE(p + 12);
  const duration = buf.readUInt32BE(p + 16);
  if (timescale === 0) throw new MediaProbeError('malformed', 'mvhd timescale is zero.');
  return duration / timescale;
}

function parseMdhd(buf: Buffer, box: { start: number; headerSize: number; size: number }): number {
  const p = box.start + box.headerSize;
  const version = buf.readUInt8(p);
  if (version === 1) {
    const timescale = buf.readUInt32BE(p + 20);
    const duration = Number(buf.readBigUInt64BE(p + 24));
    return timescale === 0 ? 0 : duration / timescale;
  }
  const timescale = buf.readUInt32BE(p + 12);
  const duration = buf.readUInt32BE(p + 16);
  return timescale === 0 ? 0 : duration / timescale;
}

/** Implied bitrate sanity window for compressed speech audio (bits per second). */
export const MIN_PLAUSIBLE_BITRATE = 8_000;
export const MAX_PLAUSIBLE_BITRATE = 512_000;

export function impliedBitrate(bytes: number, durationSeconds: number): number {
  return durationSeconds > 0 ? (bytes * 8) / durationSeconds : Number.POSITIVE_INFINITY;
}

function parseHdlrType(buf: Buffer, box: { start: number; headerSize: number; size: number }): string {
  const p = box.start + box.headerSize;
  // version/flags (4) + pre_defined (4) + handler_type (4)
  return buf.toString('latin1', p + 8, p + 12);
}

function parseStsdAudio(buf: Buffer, stsd: { start: number; headerSize: number; size: number }) {
  const p = stsd.start + stsd.headerSize;
  const entryCount = buf.readUInt32BE(p + 4);
  if (entryCount < 1) return null;
  const entry = readBox(buf, p + 8, stsd.start + stsd.size);
  if (!entry) return null;
  const e = entry.start + entry.headerSize;
  // SampleEntry: reserved(6) data_reference_index(2); AudioSampleEntry: version(2) revision(2) vendor(4) channelcount(2) samplesize(2) pre_defined(2) reserved(2) samplerate(4, 16.16)
  const channels = buf.readUInt16BE(e + 8 + 8);
  const sampleRate = buf.readUInt32BE(e + 8 + 16) >>> 16;
  return { codec: entry.type.trim(), channels, sample_rate: sampleRate };
}

export function probeMp4(buf: Buffer): MediaProbe {
  if (buf.length < 24) throw new MediaProbeError('too_short', 'File is too small to be an audio container.');
  const first = readBox(buf, 0, buf.length);
  if (!first || first.type !== 'ftyp') throw new MediaProbeError('unsupported_container', 'File does not start with an MP4 ftyp box.');
  const brand = buf.toString('latin1', first.start + 8, first.start + 12);
  if (!MP4_BRANDS.has(brand)) {
    // Check compatible brands before rejecting.
    let ok = false;
    for (let o = first.start + 16; o + 4 <= first.start + first.size; o += 4) {
      if (MP4_BRANDS.has(buf.toString('latin1', o, o + 4))) ok = true;
    }
    if (!ok) throw new MediaProbeError('unsupported_container', `Unsupported MP4 brand ${JSON.stringify(brand)}.`);
  }
  const moov = findChild(buf, 0, buf.length, 'moov');
  if (!moov) throw new MediaProbeError('malformed', 'No moov box found (incomplete or non-audio file).');
  const mvhd = findChild(buf, moov.start + moov.headerSize, moov.start + moov.size, 'mvhd');
  if (!mvhd) throw new MediaProbeError('malformed', 'No mvhd box found.');
  const duration = parseMvhd(buf, mvhd);

  let audioTracks = 0;
  let hasVideo = false;
  let trackDuration = 0;
  let audio: { codec: string; channels: number; sample_rate: number } | null = null;
  for (const trak of boxes(buf, moov.start + moov.headerSize, moov.start + moov.size)) {
    if (trak.type !== 'trak') continue;
    const mdia = findChild(buf, trak.start + trak.headerSize, trak.start + trak.size, 'mdia');
    if (!mdia) continue;
    const hdlr = findChild(buf, mdia.start + mdia.headerSize, mdia.start + mdia.size, 'hdlr');
    const handler = hdlr ? parseHdlrType(buf, hdlr) : '';
    if (handler === 'vide') hasVideo = true;
    if (handler !== 'soun') continue;
    audioTracks += 1;
    const mdhd = findChild(buf, mdia.start + mdia.headerSize, mdia.start + mdia.size, 'mdhd');
    if (mdhd) trackDuration = Math.max(trackDuration, parseMdhd(buf, mdhd));
    const minf = findChild(buf, mdia.start + mdia.headerSize, mdia.start + mdia.size, 'minf');
    const stbl = minf ? findChild(buf, minf.start + minf.headerSize, minf.start + minf.size, 'stbl') : null;
    const stsd = stbl ? findChild(buf, stbl.start + stbl.headerSize, stbl.start + stbl.size, 'stsd') : null;
    if (stsd && !audio) audio = parseStsdAudio(buf, stsd);
  }
  if (hasVideo) throw new MediaProbeError('video_present', 'Video tracks are not accepted.');
  if (audioTracks === 0) throw new MediaProbeError('no_audio_track', 'No audio track found.');
  return {
    container: 'mp4',
    brand,
    // The movie header can under-declare; the audio track's own duration is authoritative when longer.
    duration_seconds: Math.max(duration, trackDuration),
    codec: audio?.codec ?? null,
    channels: audio?.channels ?? null,
    sample_rate: audio?.sample_rate ?? null,
    audio_tracks: audioTracks,
    has_video: false,
  };
}

/**
 * MP3 duration estimate from frame headers (CBR/VBR by walking frames).
 * Accepted only as a secondary format; the mobile client records M4A.
 */
export function probeMp3(buf: Buffer): MediaProbe {
  let offset = 0;
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
    offset = 10 + size;
  }
  const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]; // MPEG1 L3 kbps
  const BITRATES2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]; // MPEG2/2.5 L3
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] } as Record<number, number[]>;
  let frames = 0;
  let seconds = 0;
  let sampleRate: number | null = null;
  let channels: number | null = null;
  while (offset + 4 <= buf.length) {
    const b0 = buf[offset]!;
    const b1 = buf[offset + 1]!;
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) {
      if (frames === 0) {
        offset += 1;
        continue;
      }
      break;
    }
    const versionBits = (b1 >> 3) & 0x03; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layerBits = (b1 >> 1) & 0x03; // 1 = Layer III
    if (layerBits !== 1 || versionBits === 1) break;
    const b2 = buf[offset + 2]!;
    const bitrateIdx = (b2 >> 4) & 0x0f;
    const rateIdx = (b2 >> 2) & 0x03;
    const padding = (b2 >> 1) & 0x01;
    const rates = RATES[versionBits];
    if (!rates || rateIdx === 3 || bitrateIdx === 0 || bitrateIdx === 15) break;
    const sr = rates[rateIdx]!;
    const kbps = (versionBits === 3 ? BITRATES : BITRATES2)[bitrateIdx]!;
    const samplesPerFrame = versionBits === 3 ? 1152 : 576;
    const frameLen = Math.floor((samplesPerFrame / 8) * (kbps * 1000) / sr) + padding;
    if (frameLen <= 0) break;
    const mode = (buf[offset + 3]! >> 6) & 0x03;
    channels = mode === 3 ? 1 : 2;
    sampleRate = sr;
    seconds += samplesPerFrame / sr;
    frames += 1;
    offset += frameLen;
  }
  if (frames === 0) throw new MediaProbeError('unsupported_container', 'No MPEG audio frames found.');
  return { container: 'mp3', brand: null, duration_seconds: seconds, codec: 'mp3', channels, sample_rate: sampleRate, audio_tracks: 1, has_video: false };
}

export function probeAudio(buf: Buffer): MediaProbe {
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') return probeMp4(buf);
  if (buf.length >= 3 && (buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0))) return probeMp3(buf);
  throw new MediaProbeError('unsupported_container', 'Unrecognized audio container. Record M4A/AAC audio.');
}

// ---------------------------------------------------------------------------
// WAV (RIFF/PCM) — produced by the Gemini speech adapter, never accepted as a
// learner upload (uploads must be M4A/AAC or MP3; see probeAudio).
// ---------------------------------------------------------------------------

export interface WavProbe {
  container: 'wav';
  duration_seconds: number;
  codec: 'pcm';
  channels: number;
  sample_rate: number;
  bits_per_sample: number;
}

export function probeWav(buf: Buffer): WavProbe {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new MediaProbeError('unsupported_container', 'Not a RIFF/WAVE file.');
  }
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let dataBytes: number | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (body + 16 > buf.length) throw new MediaProbeError('malformed', 'Truncated fmt chunk.');
      const format = buf.readUInt16LE(body);
      if (format !== 1 && format !== 0xfffe) throw new MediaProbeError('unsupported_container', `WAV format ${format} is not PCM.`);
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      dataBytes = Math.min(size, buf.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataBytes === null) throw new MediaProbeError('malformed', 'WAV file has no fmt or data chunk.');
  const bytesPerSecond = fmt.channels * fmt.sampleRate * (fmt.bitsPerSample / 8);
  if (bytesPerSecond <= 0) throw new MediaProbeError('malformed', 'WAV format has zero rate.');
  return { container: 'wav', duration_seconds: dataBytes / bytesPerSecond, codec: 'pcm', channels: fmt.channels, sample_rate: fmt.sampleRate, bits_per_sample: fmt.bitsPerSample };
}

/** Duration probe for server-generated speech (MP3 from OpenAI, WAV from Gemini). */
export function probeGeneratedAudio(buf: Buffer): { duration_seconds: number; container: 'mp4' | 'mp3' | 'wav' } {
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') {
    const p = probeWav(buf);
    return { duration_seconds: p.duration_seconds, container: p.container };
  }
  const p = probeAudio(buf);
  return { duration_seconds: p.duration_seconds, container: p.container };
}

/** Wraps raw little-endian PCM samples in a 44-byte WAV header. */
export function pcmToWav(pcm: Buffer, opts: { sampleRate: number; channels: number; bitsPerSample: number }): Buffer {
  const blockAlign = opts.channels * (opts.bitsPerSample / 8);
  const byteRate = opts.sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(opts.channels, 22);
  header.writeUInt32LE(opts.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(opts.bitsPerSample, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
