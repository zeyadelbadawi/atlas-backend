/**
 * `ProtectedMediaStorage` — object storage for content that must never be
 * reachable by URL alone (master plan Phase 2 §D.1, finding S1).
 *
 * A SEPARATE BUCKET, NOT A PREFIX. The public bucket is reachable by URL
 * by design — `R2_PUBLIC_URL_BASE` exists precisely so a browser can fetch
 * a logo — so a "protected/" prefix inside it would be protected by
 * nothing but nobody having guessed the key, which is exactly the property
 * S1 says is not a security control. This bucket has no public base URL at
 * all; every read is a presigned GET minted per request, valid for ten
 * minutes (Phase 2 §I).
 *
 * Deliberately a different class from `R2StorageProvider` rather than a
 * flag on it: that class's contract is "returns the durable public URL",
 * and a durable public URL is the one thing this tier must never produce.
 * Keeping them apart means no call site can accidentally get the wrong
 * one, and `MediaStorageProvider`'s existing consumers are untouched.
 *
 * Both talk to the same S3-compatible endpoint — real Cloudflare R2 in
 * production, the local MinIO container in development — so this is real
 * protocol code in every environment, never a stub.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  MediaStorageConfig,
  ProtectedMediaConfig,
} from '../../config/configuration';

const bucketsEnsured = new Set<string>();

@Injectable()
export class ProtectedMediaStorage implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProtectedMediaStorage.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly defaultTtlSeconds: number;

  constructor(configService: ConfigService) {
    const media = configService.getOrThrow<MediaStorageConfig>('media');
    const protectedMedia =
      configService.getOrThrow<ProtectedMediaConfig>('protectedMedia');
    this.bucket = protectedMedia.bucket;
    this.defaultTtlSeconds = protectedMedia.signedUrlTtlSeconds;
    // Endpoint, region and addressing style are properties of the R2
    // account and are shared. The CREDENTIALS are not: they come from
    // `protectedMedia`, which is the dedicated single-bucket token when
    // one is configured and the public media token otherwise. A token
    // scoped to the protected bucket alone means a leak of it cannot
    // touch the public bucket, and a leak of the public one cannot reach
    // protected lesson media.
    this.client = new S3Client({
      region: media.region,
      endpoint: media.endpoint,
      forcePathStyle: media.forcePathStyle,
      credentials: {
        accessKeyId: protectedMedia.accessKeyId,
        secretAccessKey: protectedMedia.secretAccessKey,
      },
    });
  }

  /** Closes the client's keep-alive sockets when the application shuts down. */
  onModuleDestroy(): void {
    this.client.destroy();
  }

  /**
   * Module-scoped bucket ensure, matching `R2StorageProvider`'s own
   * reasoning verbatim: the e2e suite boots a fresh app per spec file in a
   * single process, and a per-instance check would add a real network
   * round-trip to every one of those boots.
   */
  async onModuleInit(): Promise<void> {
    if (bucketsEnsured.has(this.bucket)) return;
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created protected object-storage bucket "${this.bucket}".`);
    } catch (error) {
      const code =
        error instanceof S3ServiceException
          ? error.name
          : (error as { Code?: string })?.Code;
      const status =
        error instanceof S3ServiceException
          ? error.$metadata?.httpStatusCode
          : (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
              ?.httpStatusCode;
      const tolerated =
        code === 'BucketAlreadyOwnedByYou' ||
        code === 'BucketAlreadyExists' ||
        code === 'AccessDenied' ||
        status === 409 ||
        status === 403;
      if (!tolerated) throw error;
    }
    bucketsEnsured.add(this.bucket);
  }

  /**
   * The longest a presigned URL from this store can live.
   *
   * Exposed so a caller can report the credential's REAL expiry rather
   * than the one it asked for — the mistake finding D-3 recorded, where a
   * grant advertised two hours for a URL this class had clamped to ten
   * minutes.
   */
  get maxTtlSeconds(): number {
    return this.defaultTtlSeconds;
  }

  /**
   * The object key for protected content.
   *
   * Prefixed by academy and course FROM VERIFIED CONTEXT (Phase 2 §H) —
   * never from anything a caller sent. Two things follow: a listing of the
   * bucket is already grouped by tenant for an incident response, and a
   * key built for one academy can never be mistaken for another's.
   */
  static objectKey(args: {
    readonly academyId: string;
    readonly courseId?: string | null;
    readonly assetId: string;
    readonly extension: string;
  }): string {
    const course = args.courseId ? `courses/${args.courseId}/` : '';
    const extension = args.extension.replace(/^\.+/, '');
    return `academies/${args.academyId}/${course}${args.assetId}.${extension}`;
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * A short-lived GET. `ttlSeconds` is CLAMPED to the configured ceiling
   * rather than trusted: the caller that wants a longer URL is the bug
   * this clamp catches, and the environment variable is already capped at
   * one hour by `env.validation.ts`.
   */
  /**
   * P64 Phase 3 — a presign whose lifetime is a DIFFERENT purpose from a
   * lesson-content grant: certificate downloads (one hour, capped at one
   * hour by `env.validation.ts`). Never used for lesson content, whose
   * TTL stays the grant signer's business.
   */
  presignGetWithTtl(key: string, ttlSeconds: number): Promise<string> {
    const expiresIn = Math.max(60, Math.min(Math.floor(ttlSeconds), 3600));
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn },
    );
  }

  presignGet(key: string, ttlSeconds?: number): Promise<string> {
    const expiresIn = Math.min(
      ttlSeconds ?? this.defaultTtlSeconds,
      this.defaultTtlSeconds,
    );
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        // Belt and braces with the grant response's own header: a
        // presigned URL is a bearer credential, and a shared cache holding
        // a copy of protected bytes would outlive the credential.
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn },
    );
  }

  presignPut(key: string, contentType: string, ttlSeconds?: number): Promise<string> {
    const expiresIn = Math.min(
      ttlSeconds ?? this.defaultTtlSeconds,
      this.defaultTtlSeconds,
    );
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn },
    );
  }

  /**
   * Reads the first `bytes` of an object.
   *
   * Exists for one purpose: establishing a video's real duration from its
   * container metadata without downloading the whole file (D5). A ranged
   * GET of a few hundred kilobytes is enough for a faststart MP4 and
   * costs no transcoding.
   *
   * Returns null when the object is missing — the completion endpoint
   * turns that into "the upload never landed", which is a real and
   * distinct outcome from "landed but unreadable".
   */
  async readHead(key: string, bytes: number): Promise<Buffer | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: `bytes=0-${(bytes - 1).toString()}`,
        }),
      );
      const body = response.Body as { transformToByteArray?: () => Promise<Uint8Array> };
      if (!body.transformToByteArray) return null;
      return Buffer.from(await body.transformToByteArray());
    } catch {
      return null;
    }
  }

  /** Object size and content type, without reading the bytes. Used to confirm an upload actually landed. */
  async headObject(
    key: string,
  ): Promise<{ readonly sizeBytes: number; readonly contentType?: string } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        sizeBytes: response.ContentLength ?? 0,
        contentType: response.ContentType,
      };
    } catch {
      return null;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
