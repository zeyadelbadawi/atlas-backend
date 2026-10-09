import { ProtectedMediaStorage } from './protected-media-storage.provider';
import type { ConfigService } from '@nestjs/config';

/** W6 — the only size bound a presigned PUT can carry is a signed Content-Length. */
describe('ProtectedMediaStorage.presignPut content length (W6)', () => {
  const storage = new ProtectedMediaStorage({
    getOrThrow: (key: string) =>
      key === 'protectedMedia'
        ? {
            bucket: 'atlas-test-protected',
            accessKeyId: 'k',
            secretAccessKey: 's',
            signedUrlTtlSeconds: 600,
            maxUploadBytes: 1,
            maxVideoUploadBytes: 1,
          }
        : {
            endpoint: 'http://127.0.0.1:9',
            region: 'us-east-1',
            forcePathStyle: true,
            accessKeyId: 'k',
            secretAccessKey: 's',
            bucket: 'atlas-test',
          },
  } as unknown as ConfigService);

  it('signs Content-Length when a size is given', async () => {
    const url = new URL(await storage.presignPut('k.mp4', 'video/mp4', undefined, 1234));
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain(
      'content-length',
    );
  });

  it('leaves it unsigned when no size is declared (bounded at completion instead)', async () => {
    const url = new URL(await storage.presignPut('k.mp4', 'video/mp4'));
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).not.toContain(
      'content-length',
    );
  });
});
