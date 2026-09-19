import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ObjectStorage, SignedRead, SignedUpload } from './types.js';

/**
 * Development/test storage on the local disk. The API serves the signed
 * URLs itself (/v1/local-storage/...) after checking an HMAC token, so the
 * mobile client exercises the same upload/playback contract as production.
 * Refused in production by configuration.
 */
export class LocalStorage implements ObjectStorage {
  readonly kind = 'local' as const;
  private readonly secret: Buffer;

  constructor(
    private readonly dir: string,
    private readonly publicBaseUrl: string,
    secret?: string,
  ) {
    mkdirSync(dir, { recursive: true });
    this.secret = secret ? Buffer.from(secret) : randomBytes(32);
  }

  private pathFor(objectKey: string): string {
    const safe = path.normalize(objectKey).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(this.dir, safe);
    if (!full.startsWith(path.resolve(this.dir))) throw new Error('storage: invalid object key');
    return full;
  }

  sign(objectKey: string, op: 'put' | 'get', expiresAt: number): string {
    return createHmac('sha256', this.secret).update(`${op}\n${objectKey}\n${expiresAt}`).digest('base64url');
  }

  verifyToken(objectKey: string, op: 'put' | 'get', expiresAt: number, token: string): boolean {
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
    const expected = Buffer.from(this.sign(objectKey, op, expiresAt));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  async createSignedUpload(objectKey: string, opts: { contentType: string; ttlSeconds: number }): Promise<SignedUpload> {
    const expiresAt = Date.now() + opts.ttlSeconds * 1000;
    const token = this.sign(objectKey, 'put', expiresAt);
    const url = `${this.publicBaseUrl}/v1/local-storage/${encodeURIComponent(objectKey)}?exp=${expiresAt}&token=${token}`;
    return { url, token, method: 'PUT', headers: { 'Content-Type': opts.contentType }, expiresAt: new Date(expiresAt) };
  }

  async head(objectKey: string) {
    const p = this.pathFor(objectKey);
    if (!existsSync(p)) return null;
    const meta = existsSync(`${p}.meta.json`) ? (JSON.parse(readFileSync(`${p}.meta.json`, 'utf8')) as { contentType?: string }) : {};
    return { bytes: statSync(p).size, contentType: meta.contentType ?? null };
  }

  async download(objectKey: string): Promise<Buffer> {
    const p = this.pathFor(objectKey);
    if (!existsSync(p)) throw new Error('storage: object not found');
    return readFileSync(p);
  }

  async upload(objectKey: string, bytes: Buffer, contentType: string): Promise<void> {
    const p = this.pathFor(objectKey);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, bytes);
    writeFileSync(`${p}.meta.json`, JSON.stringify({ contentType }));
  }

  async createSignedRead(objectKey: string, ttlSeconds: number): Promise<SignedRead> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const token = this.sign(objectKey, 'get', expiresAt);
    return {
      url: `${this.publicBaseUrl}/v1/local-storage/${encodeURIComponent(objectKey)}?exp=${expiresAt}&token=${token}`,
      expiresAt: new Date(expiresAt),
    };
  }

  async remove(objectKeys: string[]): Promise<void> {
    for (const key of objectKeys) {
      const p = this.pathFor(key);
      rmSync(p, { force: true });
      rmSync(`${p}.meta.json`, { force: true });
    }
  }

  exists(objectKey: string): boolean {
    return existsSync(this.pathFor(objectKey));
  }
}
