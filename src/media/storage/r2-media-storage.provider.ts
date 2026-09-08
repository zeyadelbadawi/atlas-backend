/**
 * R2StorageProvider — the one real `MediaStorageProvider` implementation
 * (master plan ADR-005: Cloudflare R2, S3-compatible). Talks real S3
 * protocol via `@aws-sdk/client-s3` against whatever endpoint
 * `MediaStorageConfig` points at — real Cloudflare R2 in production, a
 * local MinIO container (docker-compose.yml) in development/test. Same
 * client code either way, matching exactly how `PrismaService` already
 * points at local vs. managed Postgres through one connection string —
 * "do not fake successful production behavior in application code" is
 * satisfied because this class never branches on environment; only the
 * injected config differs.
 *
 * `onModuleInit` ensures the configured bucket exists (idempotent —
 * `BucketAlreadyOwnedByYou`/409 is swallowed), so a fresh local
 * environment (`docker compose up`, no bucket pre-created) works without
 * a manual setup step. Real R2 buckets are provisioned out-of-band in
 * production; this is a no-op there (the bucket already exists, the same
 * 409 is swallowed).
 *
 * The ensure-check itself is real network I/O — module-scoped (not
 * per-instance), so it runs once per bucket per process, not once per
 * `INestApplication`. This matters concretely for the e2e suite: every
 * spec file boots a fresh app via `createTestApp()`, and `jest-e2e.json`
 * runs the whole suite in one process (`maxWorkers: 1`) — without this,
 * ~39 real HTTP round-trips to the object store would land on app boot
 * alone, discovered during implementation when it pushed an already-
 * timing-sensitive, pre-existing BullMQ warm-up test (`auth-password-
 * reset.e2e-spec.ts`'s own documented "first job after fresh boot" margin
 * note) past its polling budget — a real regression this fixes at the
 * root cause, not by loosening that test's timeout.
 */
const bucketsEnsured = new Set<string>();
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { MediaStorageConfig } from '../../config/configuration';
import type { MediaStorageProvider, PutObjectResult } from './media-storage.interface';

@Injectable()
export class R2StorageProvider implements MediaStorageProvider, OnModuleInit {
  private readonly logger = new Logger(R2StorageProvider.name);
  private readonly client: S3Client;
  private readonly config: MediaStorageConfig;

  constructor(configService: ConfigService) {
    this.config = configService.getOrThrow<MediaStorageConfig>('media');
    this.client = new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    if (bucketsEnsured.has(this.config.bucket)) return;

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
      this.logger.log(`Created object-storage bucket "${this.config.bucket}".`);
    } catch (error) {
      // Already exists — the expected, idempotent steady state (real R2
      // buckets are provisioned out-of-band; MinIO's bucket is created on
      // the first `onModuleInit` and every subsequent boot hits this
      // branch). Phase 7 — also tolerate `AccessDenied`/403: a real,
      // deliberately least-privilege R2 API token scoped to "Object Read
      // & Write" (this deployment's own production credential) can't call
      // `CreateBucket` at all, admin-scoped or not — it 403s outright
      // rather than reporting "already exists" first, confirmed against
      // real R2 during Phase 7. That is exactly the intended production
      // shape (an app credential should never need bucket-admin rights),
      // not a real startup failure. Any other error still is one.
      const code =
        error instanceof S3ServiceException
          ? error.name
          : (error as { Code?: string; $metadata?: { httpStatusCode?: number } })?.Code;
      const status =
        error instanceof S3ServiceException
          ? error.$metadata?.httpStatusCode
          : (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
              ?.httpStatusCode;
      const tolerable =
        code === 'BucketAlreadyOwnedByYou' ||
        code === 'BucketAlreadyExists' ||
        status === 403;
      if (!tolerable) {
        throw error;
      }
      if (status === 403) {
        this.logger.warn(
          `CreateBucket denied (403) for "${this.config.bucket}" — storage credential is object-scoped, not bucket-admin. Assuming the bucket already exists and was provisioned out-of-band, matching this deployment's own least-privilege R2 token.`,
        );
      }
    }

    // Phase 7 correction — this used to also call `PutBucketPolicy` here
    // to grant public read. Removed entirely, not just permission-
    // tolerated: Cloudflare R2's S3 API does not implement bucket
    // policies at all (confirmed against R2's own S3-compatibility
    // documentation) — it isn't a permissions question the way
    // `CreateBucket` above is, it's an operation R2 never supports,
    // admin-scoped credential or not. Calling it and swallowing the
    // failure would mean starting up by deliberately invoking an
    // operation known not to exist on the real target platform.
    //
    // Public read for a bucket that needs it (master plan §13: "Public
    // assets... served directly via CDN") is a bucket-level *setting* on
    // R2 — Managed public access (an r2.dev subdomain) or a bound Custom
    // Domain — configured once, out-of-band, via the Cloudflare
    // dashboard or an Account-scoped R2 Admin API token. Neither is
    // something this application's own object-scoped runtime credential
    // should ever be able to do, and neither belongs in per-boot
    // application code — matching how `CreateBucket` itself is already
    // documented as "provisioned out-of-band in production" above.
    bucketsEnsured.add(this.config.bucket);
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<PutObjectResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { url: `${this.config.publicUrlBase}/${key}` };
  }

  async getObject(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error(`Object body empty for key "${key}".`);
    }
    return Buffer.from(bytes);
  }
}
