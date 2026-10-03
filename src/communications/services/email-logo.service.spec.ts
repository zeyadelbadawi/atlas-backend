/**
 * W3 — EmailLogoService turns any usable stored logo into a bounded PNG,
 * and anything else into "no logo" (the email then shows the name).
 * Real sharp, fake storage.
 */
import sharp from 'sharp';
import { EmailLogoService } from './email-logo.service';
import type { MediaStorageProvider } from '../../media/storage/media-storage.interface';
import type { LinkBuilderService } from './link-builder.service';

const A = '11111111-1111-4111-8111-111111111111';
const FILE = '33333333-3333-4333-8333-333333333333';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function image(format: 'png' | 'webp' | 'jpeg', width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .toFormat(format)
    .toBuffer();
}

function setup(objects: Record<string, Buffer> = {}) {
  const getObject = jest.fn(async (key: string) => {
    const found = objects[key];
    if (!found) throw new Error('NoSuchKey');
    return found;
  });
  const storage = { getObject } as unknown as MediaStorageProvider;
  const links = {
    platform: (path = '/') => `https://app.atlas.test${path}`,
  } as unknown as LinkBuilderService;
  return { service: new EmailLogoService(storage, links), getObject };
}

describe('EmailLogoService', () => {
  it('rasterises a WebP media logo to PNG, bounded to 480×160', async () => {
    const key = `academies/${A}/${FILE}.webp`;
    const { service } = setup({ [key]: await image('webp', 1200, 400) });
    const logo = await service.render(
      A,
      `/api/v1/public/media/academies/${A}/${FILE}.webp`,
    );
    expect(logo).not.toBeNull();
    expect(logo!.png.subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
    expect(logo!.width).toBe(480);
    expect(logo!.height).toBe(160);
  });

  it('serves an inline JPEG data URI as PNG and never enlarges a small logo', async () => {
    const jpeg = await image('jpeg', 90, 30);
    const { service } = setup();
    const logo = await service.render(
      A,
      `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    );
    expect(logo!.png.subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
    expect([logo!.width, logo!.height]).toEqual([90, 30]);
  });

  it('builds the absolute platform-host URL with the version and display size', async () => {
    const png = await image('png', 300, 100);
    const stored = `data:image/png;base64,${png.toString('base64')}`;
    const { service } = setup();
    const ref = await service.forEmail(A, stored);
    expect(ref?.url).toMatch(
      new RegExp(
        `^https://app\\.atlas\\.test/api/v1/public/websites/${A}/logo\\?v=[0-9a-f]{16}$`,
      ),
    );
    expect(ref).toMatchObject({ width: 120, height: 40 });
  });

  it('caches by (academy, version): a burst costs one storage read', async () => {
    const key = `academies/${A}/${FILE}.png`;
    const { service, getObject } = setup({ [key]: await image('png', 100, 40) });
    const stored = `/api/v1/public/media/academies/${A}/${FILE}.png`;
    await Promise.all([service.render(A, stored)]);
    await service.render(A, stored);
    await service.render(A, stored);
    expect(getObject).toHaveBeenCalledTimes(1);
  });

  it('returns null (text fallback) for a missing object, undecodable bytes or a remote URL', async () => {
    const { service, getObject } = setup();
    expect(
      await service.render(A, `/api/v1/public/media/academies/${A}/${FILE}.png`),
    ).toBeNull();
    expect(await service.render(A, 'data:image/png;base64,bm90LWFuLWltYWdl')).toBeNull();
    expect(await service.render(A, 'https://cdn.example.com/logo.png')).toBeNull();
    expect(await service.forEmail(A, null)).toBeUndefined();
    // The remote URL was never fetched through storage either.
    expect(getObject).toHaveBeenCalledTimes(1);
  });
});
