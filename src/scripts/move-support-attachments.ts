/**
 * B0-SEC-10 — moves support-ticket images stored before the fix from the
 * public media bucket to the protected bucket (same keys, so no database
 * change). See `support-attachment-move.util.ts` for exactly what each mode
 * does; this file only binds it to the two real buckets, with the
 * credentials the running backend already uses for each:
 *
 *   public     R2_BUCKET            with R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
 *   protected  R2_PROTECTED_BUCKET  with R2_PROTECTED_ACCESS_KEY_ID / _SECRET_
 *              (or `<R2_BUCKET>-protected` and the media token, as the app)
 *
 * Run inside the backend container (deploy/support-attachments-move/remote.sh):
 *   node dist/scripts/move-support-attachments.js              plan (read-only)
 *   node dist/scripts/move-support-attachments.js --apply      move
 *   node dist/scripts/move-support-attachments.js --rollback   copy back
 *
 * Prints one JSON line of counts. Never an object key: a key names a
 * support case.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import configuration from '../config/configuration';
import type { MediaStorageConfig } from '../config/configuration';
import {
  moveSupportAttachments,
  type MoveStore,
} from '../platform/utils/support-attachment-move.util';

function s3Store(
  media: MediaStorageConfig,
  bucket: string,
  credentials: { accessKeyId: string; secretAccessKey: string },
): MoveStore {
  const client = new S3Client({
    region: media.region,
    endpoint: media.endpoint,
    forcePathStyle: media.forcePathStyle,
    credentials,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return {
    async list(prefix) {
      const out: { key: string; size: number }[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const o of page.Contents ?? []) {
          if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async get(key) {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const bytes = await response.Body?.transformToByteArray();
      if (!bytes) throw new Error('empty body');
      return { body: Buffer.from(bytes), contentType: response.ContentType };
    },
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    async size(key) {
      try {
        const head = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return head.ContentLength ?? 0;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (status === 404) return null;
        throw error;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--apply' && a !== '--rollback');
  if (unknown.length > 0 || (args.includes('--apply') && args.includes('--rollback'))) {
    console.error('usage: move-support-attachments [--apply | --rollback]');
    process.exit(2);
  }
  const mode = args.includes('--apply')
    ? 'apply'
    : args.includes('--rollback')
      ? 'rollback'
      : 'plan';

  const { media, protectedMedia } = configuration();
  const publicStore = s3Store(media, media.bucket, {
    accessKeyId: media.accessKeyId,
    secretAccessKey: media.secretAccessKey,
  });
  const protectedStore = s3Store(media, protectedMedia.bucket, {
    accessKeyId: protectedMedia.accessKeyId,
    secretAccessKey: protectedMedia.secretAccessKey,
  });

  const summary = await moveSupportAttachments(mode, publicStore, protectedStore);
  console.log(JSON.stringify(summary));
  if (summary.failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  // The error class only: an SDK message can carry a bucket key.
  console.error(`FAIL  ${(error as Error)?.name ?? 'Error'}`);
  process.exit(1);
});
