import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectInfo, ObjectStorage, SignedRead, SignedUpload } from './types.js';

export interface S3StorageOptions {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Custom endpoint for S3-compatible stores (Railway Buckets: https://t3.storageapi.dev). Omit for AWS. */
  endpoint?: string | undefined;
  /** Path-style addressing for stores that do not support virtual-hosted buckets. */
  forcePathStyle?: boolean | undefined;
}

/**
 * S3-compatible private bucket (Railway Buckets, AWS S3, R2, MinIO). The
 * server holds the only credentials; clients receive per-object presigned
 * URLs with short TTLs after ownership was verified. Flexible checksums are
 * restricted to operations that require them so presigned PUTs and
 * third-party stores interoperate.
 */
export class S3Storage implements ObjectStorage {
  readonly kind = 's3' as const;
  readonly client: S3Client;

  constructor(
    private readonly opts: S3StorageOptions,
    client?: S3Client,
  ) {
    const config: S3ClientConfig = {
      region: opts.region,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle ?? false,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    };
    this.client = client ?? new S3Client(config);
  }

  get bucket(): string {
    return this.opts.bucket;
  }

  async createSignedUpload(objectKey: string, opts: { contentType: string; ttlSeconds: number }): Promise<SignedUpload> {
    const url = await getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.opts.bucket, Key: objectKey, ContentType: opts.contentType }), { expiresIn: opts.ttlSeconds });
    return { url, token: null, method: 'PUT', headers: { 'Content-Type': opts.contentType }, expiresAt: new Date(Date.now() + opts.ttlSeconds * 1000) };
  }

  async head(objectKey: string): Promise<ObjectInfo | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: objectKey }));
      return { bytes: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw wrap('head', err);
    }
  }

  async download(objectKey: string): Promise<Buffer> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: objectKey }));
      if (!res.Body) throw new Error('empty body');
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      throw wrap('download', err);
    }
  }

  async upload(objectKey: string, bytes: Buffer, contentType: string): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: objectKey, Body: bytes, ContentType: contentType, ContentLength: bytes.length }));
    } catch (err) {
      throw wrap('upload', err);
    }
  }

  async createSignedRead(objectKey: string, ttlSeconds: number): Promise<SignedRead> {
    const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.opts.bucket, Key: objectKey }), { expiresIn: ttlSeconds });
    return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
  }

  async remove(objectKeys: string[]): Promise<void> {
    for (const key of objectKeys) {
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      } catch (err) {
        if (isNotFound(err)) continue;
        throw wrap('remove', err);
      }
    }
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/** Storage errors carry the operation and status only; never the signed URL or credentials. */
function wrap(op: string, err: unknown): Error {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; message?: string } | null;
  return new Error(`storage: ${op} failed (${e?.name ?? 'error'}${e?.$metadata?.httpStatusCode ? ` ${e.$metadata.httpStatusCode}` : ''})`);
}
