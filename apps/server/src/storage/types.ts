/**
 * Private object storage abstraction. Every operation is server-side; the
 * client only ever receives short-lived, single-object capabilities minted
 * here after the API verified ownership.
 */
export interface SignedUpload {
  url: string;
  token: string | null;
  method: 'PUT' | 'POST';
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface SignedRead {
  url: string;
  expiresAt: Date;
}

export interface ObjectInfo {
  bytes: number;
  contentType: string | null;
}

export interface ObjectStorage {
  readonly kind: 'supabase' | 'local';
  createSignedUpload(objectKey: string, opts: { contentType: string; ttlSeconds: number }): Promise<SignedUpload>;
  head(objectKey: string): Promise<ObjectInfo | null>;
  download(objectKey: string): Promise<Buffer>;
  upload(objectKey: string, bytes: Buffer, contentType: string): Promise<void>;
  createSignedRead(objectKey: string, ttlSeconds: number): Promise<SignedRead>;
  /** Idempotent: deleting a missing object resolves. */
  remove(objectKeys: string[]): Promise<void>;
}

/**
 * Object key derived only from verified server data. The client never
 * chooses a bucket, path, or owner.
 */
export function rawAudioKey(userId: string, attemptId: string, assetId: string): string {
  return `users/${userId}/attempts/${attemptId}/raw/${assetId}.m4a`;
}

export function ttsAudioKey(userId: string, attemptId: string, rewriteId: string, assetId: string): string {
  return `users/${userId}/attempts/${attemptId}/tts/${rewriteId}/${assetId}.mp3`;
}

export function ownerOfKey(objectKey: string): string | null {
  const m = /^users\/([0-9a-f-]{36})\//i.exec(objectKey);
  return m ? m[1]!.toLowerCase() : null;
}
