/**
 * CMS phase 4 — `ImageVariantsService` against an in-memory object store:
 * variants land at their derived keys before the row lists them, and a
 * failure never throws (best-effort by contract).
 */
import sharp from 'sharp';
import type { MediaStorageProvider } from '../storage/media-storage.interface';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { MediaAssetsRepository } from '../repositories/media-assets.repository';
import { ImageVariantsService } from './image-variants.service';

class InMemoryStorage implements MediaStorageProvider {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  async putObject(key: string, body: Buffer, contentType: string) {
    this.objects.set(key, { body, contentType });
    return { url: `/api/v1/public/media/${key}` };
  }
  async getObject(key: string): Promise<Buffer> {
    const object = this.objects.get(key);
    if (!object) throw new Error('NoSuchKey');
    return object.body;
  }
  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async objectExists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
}

const KEY = 'academies/a1/f00d.jpg';
const asset = {
  id: 'asset-1',
  type: 'image' as const,
  access: 'public' as const,
  provider: 'r2' as const,
  mimeType: 'image/jpeg',
  storageKey: KEY,
};

function setup() {
  const storage = new InMemoryStorage();
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const repository = {
    update: jest.fn(async (_tx: unknown, id: string, data: Record<string, unknown>) => {
      // The row may only list objects that already exist.
      for (const variant of data.variants as { width: number; format: string }[]) {
        expect(
          storage.objects.has(
            `academies/a1/variants/f00d/w${variant.width}.${variant.format}`,
          ),
        ).toBe(true);
      }
      updates.push({ id, data });
      return {};
    }),
  } as unknown as MediaAssetsRepository;
  const tenancy = {
    runInTenantContext: (_org: string, work: (tx: unknown) => unknown) => work({}),
  } as unknown as TenancyContextService;
  return {
    storage,
    updates,
    service: new ImageVariantsService(tenancy, repository, storage),
  };
}

describe('ImageVariantsService', () => {
  it('stores each variant at its derived key with its type, then records the list', async () => {
    const { storage, updates, service } = setup();
    const original = await sharp({
      create: { width: 1000, height: 500, channels: 3, background: '#123456' },
    })
      .jpeg()
      .toBuffer();
    await storage.putObject(KEY, original, 'image/jpeg');

    await expect(service.generateForAsset(asset, 'org-1')).resolves.toBe('generated');

    expect(storage.objects.get('academies/a1/variants/f00d/w480.avif')?.contentType).toBe(
      'image/avif',
    );
    expect(
      storage.objects.get('academies/a1/variants/f00d/w1000.webp')?.contentType,
    ).toBe('image/webp');
    expect(storage.objects.get(KEY)?.body).toBe(original);
    expect(updates).toHaveLength(1);
    expect(
      (updates[0].data.variants as { width: number; format: string }[]).map(
        (variant) => `${variant.width}.${variant.format}`,
      ),
    ).toEqual(['480.avif', '480.webp', '960.avif', '960.webp', '1000.avif', '1000.webp']);
  }, 30000);

  it('skips what is not a public JPEG/PNG/WebP without reading it', async () => {
    const { storage, updates, service } = setup();
    const getObject = jest.spyOn(storage, 'getObject');
    await expect(
      service.generateForAsset({ ...asset, mimeType: 'image/gif' }, 'org-1'),
    ).resolves.toBe('skipped');
    await expect(
      service.generateForAsset({ ...asset, access: 'protected' as never }, 'org-1'),
    ).resolves.toBe('skipped');
    expect(getObject).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('reports a failure instead of throwing, and records nothing', async () => {
    const { storage, updates, service } = setup();
    await storage.putObject(KEY, Buffer.from('not an image'), 'image/jpeg');
    await expect(service.generateForAsset(asset, 'org-1')).resolves.toBe('failed');
    // A missing original is the same: best-effort, never a thrown error.
    await expect(
      service.generateForAsset(
        { ...asset, storageKey: 'academies/a1/missing.jpg' },
        'org-1',
      ),
    ).resolves.toBe('failed');
    expect(updates).toHaveLength(0);
    expect([...storage.objects.keys()]).toEqual([KEY]);
  });
});
