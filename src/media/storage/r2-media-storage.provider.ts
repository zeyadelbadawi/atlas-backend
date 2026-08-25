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
  PutBucketPolicyCommand,
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
      // branch). Any other error is a real, fatal startup problem.
      const code =
        error instanceof S3ServiceException
          ? error.name
          : (error as { Code?: string })?.Code;
      if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
        throw error;
      }
    }

    // Public read — master plan §13: "Public assets... served directly
    // via CDN, cacheable indefinitely." Without this, MinIO/R2 both
    // default a bucket to private, and every `media_assets.url` this
    // service ever returns would 403 for anyone but the storage
    // credential holder — real R2 buckets can carry this same policy
    // (its S3 API surface includes `PutBucketPolicy`), so this is one
    // idempotent call, not an environment-specific branch. Never applies
    // to a hypothetical future *private*-asset use case (signed URLs,
    // §13) — no such asset type exists in P8's own scope.
    await this.client.send(
      new PutBucketPolicyCommand({
        Bucket: this.config.bucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: '*',
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${this.config.bucket}/*`],
            },
          ],
        }),
      }),
    );
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
