/**
 * A presigned upload URL must not carry a checksum.
 *
 * The SDK's default (since 3.729) signs `x-amz-checksum-crc32` into a
 * presigned PutObject URL: the CRC32 of the EMPTY body it had at signing
 * time. A store that enforces it refuses the learner-facing upload of the
 * real bytes with 400 BadDigest — found when CI moved to a store that
 * checks (SeaweedFS). Presigning is local, so no network is involved here.
 */
import type { ConfigService } from '@nestjs/config';
import { ProtectedMediaStorage } from './protected-media-storage.provider';

function storage(): ProtectedMediaStorage {
  const values: Record<string, unknown> = {
    media: {
      region: 'auto',
      endpoint: 'https://accountid.r2.cloudflarestorage.com',
      forcePathStyle: false,
    },
    protectedMedia: {
      bucket: 'atlas-protected-test',
      accessKeyId: 'unit-test-key-id',
      secretAccessKey: 'unit-test-secret',
      signedUrlTtlSeconds: 600,
    },
  };
  return new ProtectedMediaStorage({
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService);
}

describe('ProtectedMediaStorage presigned URLs', () => {
  it('a presigned PUT signs no checksum of the (empty) body', async () => {
    const url = new URL(await storage().presignPut('academies/a/b.mp4', 'video/mp4'));
    const names = [...url.searchParams.keys()].map((k) => k.toLowerCase());
    expect(names).toContain('x-amz-signature');
    expect(names.filter((k) => k.includes('checksum'))).toEqual([]);
  });

  it('a presigned GET asks for no checksum mode either', async () => {
    const url = new URL(await storage().presignGet('academies/a/b.mp4'));
    const names = [...url.searchParams.keys()].map((k) => k.toLowerCase());
    expect(names.filter((k) => k.includes('checksum'))).toEqual([]);
  });
});
