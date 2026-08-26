/**
 * PaymentProofStorageService — real object storage for payment proofs, in
 * a bucket that stays PRIVATE (never a public-read bucket policy), unlike
 * P8's `R2StorageProvider`/`media` bucket. Master plan §5.7/§13:
 * `payment_proofs.file_url` is "private, signed-URL access only — never a
 * public asset path" — reusing P8's public media bucket would violate
 * that outright, and P8's bucket/policy is left completely untouched
 * (rule: "do not modify unrelated P0–P11 behavior").
 *
 * Derives its bucket name from the SAME R2/MinIO endpoint and credentials
 * `media` config already validates (`{R2_BUCKET}-payment-proofs`) rather
 * than requiring a second full set of storage env vars — one real object
 * store, two buckets, one private and one public, exactly matching how a
 * real Cloudflare R2 account would be provisioned. `onModuleInit`
 * idempotently ensures the bucket exists (mirrors `R2StorageProvider`'s
 * own precedent) but — the one deliberate difference — never applies a
 * public-read bucket policy. Every read goes through `getObject`, called
 * only from `PaymentService`/`PlatformPaymentService`'s own
 * guard-protected download methods, never exposed as a direct URL.
 */
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

const bucketsEnsured = new Set<string>();

@Injectable()
export class PaymentProofStorageService implements OnModuleInit {
  private readonly logger = new Logger(PaymentProofStorageService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(configService: ConfigService) {
    const media = configService.getOrThrow<MediaStorageConfig>('media');
    this.bucket = `${media.bucket}-payment-proofs`;
    this.client = new S3Client({
      region: media.region,
      endpoint: media.endpoint,
      forcePathStyle: media.forcePathStyle,
      credentials: {
        accessKeyId: media.accessKeyId,
        secretAccessKey: media.secretAccessKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    if (bucketsEnsured.has(this.bucket)) return;

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created private object-storage bucket "${this.bucket}".`);
    } catch (error) {
      const code =
        error instanceof S3ServiceException
          ? error.name
          : (error as { Code?: string })?.Code;
      if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
        throw error;
      }
    }
    // Deliberately NO `PutBucketPolicyCommand` here — this is the one
    // difference from `R2StorageProvider.onModuleInit`. MinIO/S3 buckets
    // default to private; leaving that default in place is the entire
    // point of this second bucket existing.
    bucketsEnsured.add(this.bucket);
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

  async getObject(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) {
      throw new Error(`Payment proof object body empty for key "${key}".`);
    }
    return Buffer.from(bytes);
  }
}
