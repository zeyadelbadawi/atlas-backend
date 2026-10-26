/**
 * B3 — the blog image upload: bytes decide the format, size and pixel
 * limits, re-encoding to WebP, and where the result is stored and served.
 */
import sharp from 'sharp';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import {
  BLOG_IMAGE_MAX_BYTES,
  BlogImagesService,
  encodeBlogImage,
  sniffBlogImageFormat,
} from './blog-images.service';

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

describe('blog image encoding', () => {
  it('sniffs PNG, JPEG and WebP from the bytes only', async () => {
    expect(sniffBlogImageFormat(await png(4, 4))).toBe('png');
    expect(
      sniffBlogImageFormat(
        await sharp(await png(4, 4))
          .jpeg()
          .toBuffer(),
      ),
    ).toBe('jpeg');
    expect(
      sniffBlogImageFormat(
        await sharp(await png(4, 4))
          .webp()
          .toBuffer(),
      ),
    ).toBe('webp');
    expect(sniffBlogImageFormat(Buffer.from('GIF89a......'))).toBeNull();
    expect(
      sniffBlogImageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
  });

  it('re-encodes to WebP and keeps a small image at its size', async () => {
    const result = await encodeBlogImage(await png(1200, 630));
    expect(sniffBlogImageFormat(result.data)).toBe('webp');
    expect(result).toMatchObject({ width: 1200, height: 630 });
  });

  it('fits a large image inside 2400 px', async () => {
    const result = await encodeBlogImage(await png(4800, 1200));
    expect(result).toMatchObject({ width: 2400, height: 600 });
  });

  it('refuses a side over 6000 px', async () => {
    await expect(encodeBlogImage(await png(6001, 10))).rejects.toMatchObject({
      response: { messageKey: 'errors.blog.imageDimensionsTooLarge' },
    });
  });

  it('refuses other formats, empty and truncated files', async () => {
    await expect(encodeBlogImage(Buffer.from('GIF89a'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(encodeBlogImage(Buffer.alloc(0))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const truncated = (await png(64, 64)).subarray(0, 40);
    await expect(encodeBlogImage(truncated)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses more than 5 MB', async () => {
    const big = Buffer.concat([await png(4, 4), Buffer.alloc(BLOG_IMAGE_MAX_BYTES)]);
    await expect(encodeBlogImage(big)).rejects.toBeInstanceOf(PayloadTooLargeException);
  });
});

describe('BlogImagesService.upload', () => {
  it('stores WebP under platform/blog/<uuid>.webp and returns the served URL', async () => {
    const storage = { putObject: jest.fn(async () => ({ url: 'ignored' })) };
    const audit = { write: jest.fn() };
    const tenancy = {
      runInUserContext: jest.fn(async (_u: string, work: (tx: unknown) => unknown) =>
        work({}),
      ),
    };
    const service = new BlogImagesService(
      storage as never,
      tenancy as never,
      audit as never,
    );
    const bytes = await png(800, 600);
    const result = await service.upload('po', { buffer: bytes, size: bytes.length });
    const [key, body, type] = storage.putObject.mock.calls[0] as unknown as [
      string,
      Buffer,
      string,
    ];
    expect(key).toMatch(/^platform\/blog\/[0-9a-f-]{36}\.webp$/);
    expect(type).toBe('image/webp');
    expect(sniffBlogImageFormat(body)).toBe('webp');
    expect(result).toEqual({
      url: `/api/v1/public/media/${key}`,
      width: 800,
      height: 600,
    });
    expect(audit.write).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ action: 'platform.blog_image.uploaded' }),
    );
  });

  it('refuses a request without a file', async () => {
    const service = new BlogImagesService({} as never, {} as never, {} as never);
    await expect(service.upload('po', undefined)).rejects.toMatchObject({
      response: { messageKey: 'errors.blog.imageInvalid' },
    });
  });
});
