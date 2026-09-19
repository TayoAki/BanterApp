import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ObjectStorage, SignedRead, SignedUpload } from './types.js';

/**
 * Supabase Storage (private bucket) via the service role. Signed URLs are
 * minted per object with short TTLs; there is no client policy on the bucket.
 */
export class SupabaseStorage implements ObjectStorage {
  readonly kind = 'supabase' as const;
  private readonly client: SupabaseClient;

  constructor(
    url: string,
    serviceRoleKey: string,
    private readonly bucket: string,
  ) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  async createSignedUpload(objectKey: string, opts: { contentType: string; ttlSeconds: number }): Promise<SignedUpload> {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUploadUrl(objectKey, { upsert: false });
    if (error || !data) throw new Error(`storage: could not create signed upload (${error?.message ?? 'no data'})`);
    // Supabase signed upload URLs are valid for two hours; we expose a shorter
    // client-facing expiry and reject late completions on the server.
    return {
      url: data.signedUrl,
      token: data.token,
      method: 'PUT',
      headers: { 'Content-Type': opts.contentType },
      expiresAt: new Date(Date.now() + opts.ttlSeconds * 1000),
    };
  }

  async head(objectKey: string) {
    const { data, error } = await this.client.storage.from(this.bucket).info(objectKey);
    if (error) {
      if (/not.?found|404/i.test(error.message)) return null;
      throw new Error(`storage: info failed (${error.message})`);
    }
    if (!data) return null;
    return { bytes: data.size ?? 0, contentType: data.contentType ?? null };
  }

  async download(objectKey: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(this.bucket).download(objectKey);
    if (error || !data) throw new Error(`storage: download failed (${error?.message ?? 'no data'})`);
    return Buffer.from(await data.arrayBuffer());
  }

  async upload(objectKey: string, bytes: Buffer, contentType: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).upload(objectKey, bytes, { contentType, upsert: true });
    if (error) throw new Error(`storage: upload failed (${error.message})`);
  }

  async createSignedRead(objectKey: string, ttlSeconds: number): Promise<SignedRead> {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrl(objectKey, ttlSeconds);
    if (error || !data) throw new Error(`storage: could not sign read (${error?.message ?? 'no data'})`);
    return { url: data.signedUrl, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  async remove(objectKeys: string[]): Promise<void> {
    if (objectKeys.length === 0) return;
    const { error } = await this.client.storage.from(this.bucket).remove(objectKeys);
    if (error && !/not.?found/i.test(error.message)) throw new Error(`storage: remove failed (${error.message})`);
  }
}
