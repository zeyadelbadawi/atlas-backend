/**
 * BlogImagesService — B3: `POST /platform-blog-images`, the Platform
 * Owner's image upload for blog covers, inline post images and pop-up
 * images.
 *
 *  - Accepts PNG, JPEG or WebP decided from the BYTES (magic numbers),
 *    never from the file name or the declared type; at most 5 MB and at
 *    most 6000 px on either side.
 *  - Decodes through sharp with a pixel limit (decompression bombs), one
 *    frame only, EXIF rotation applied and metadata stripped; fits the
 *    result inside 2400 x 2400 (never enlarged) and re-encodes as WebP.
 *  - Stores it under `platform/blog/<uuid>.webp` in the public media
 *    bucket and returns the site-relative URL `PublicMediaController`
 *    serves (`/api/v1/public/media/platform/blog/<uuid>.webp`).
 */
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import sharp, { type Metadata } from 'sharp';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../../media/storage/media-storage.interface';
import { toMediaAssetUrl } from '../../media/dto/media-asset.contract';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import type { BlogImageUploadResult } from '../dto/blog.contract';

export const BLOG_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const BLOG_IMAGE_MAX_SIDE = 6000;
export const BLOG_IMAGE_MAX_PIXELS = BLOG_IMAGE_MAX_SIDE * BLOG_IMAGE_MAX_SIDE;
export const BLOG_IMAGE_OUTPUT_MAX_SIDE = 2400;
export const BLOG_IMAGE_PREFIX = 'platform/blog';
const WEBP_QUALITY = 82;

export const BLOG_IMAGE_ERRORS = {
  invalid: 'errors.blog.imageInvalid',
  tooLarge: 'errors.blog.imageTooLarge',
  dimensionsTooLarge: 'errors.blog.imageDimensionsTooLarge',
} as const;

/** The parts of a multer file this service reads. */
export interface UploadedImageFile {
  readonly buffer: Buffer;
  readonly size: number;
}

export type BlogImageFormat = 'png' | 'jpeg' | 'webp';

/** The format the BYTES say they are, or `null` for anything not allowed. */
export function sniffBlogImageFormat(bytes: Buffer): BlogImageFormat | null {
  if (
    bytes.length >= 8 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

/** Validates and re-encodes an upload as WebP; throws the API's own errors. */
export async function encodeBlogImage(
  bytes: Buffer,
): Promise<{ data: Buffer; width: number; height: number }> {
  if (bytes.length === 0) {
    throw new BadRequestException({ messageKey: BLOG_IMAGE_ERRORS.invalid });
  }
  if (bytes.length > BLOG_IMAGE_MAX_BYTES) {
    throw new PayloadTooLargeException({ messageKey: BLOG_IMAGE_ERRORS.tooLarge });
  }
  const format = sniffBlogImageFormat(bytes);
  if (!format) {
    throw new BadRequestException({ messageKey: BLOG_IMAGE_ERRORS.invalid });
  }
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, {
      limitInputPixels: BLOG_IMAGE_MAX_PIXELS,
      animated: false,
      pages: 1,
    }).metadata();
  } catch {
    throw new BadRequestException({ messageKey: BLOG_IMAGE_ERRORS.invalid });
  }
  if (metadata.format !== format || !metadata.width || !metadata.height) {
    throw new BadRequestException({ messageKey: BLOG_IMAGE_ERRORS.invalid });
  }
  if (metadata.width > BLOG_IMAGE_MAX_SIDE || metadata.height > BLOG_IMAGE_MAX_SIDE) {
    throw new BadRequestException({
      messageKey: BLOG_IMAGE_ERRORS.dimensionsTooLarge,
      details: { maxSide: BLOG_IMAGE_MAX_SIDE },
    });
  }
  try {
    const { data, info } = await sharp(bytes, {
      limitInputPixels: BLOG_IMAGE_MAX_PIXELS,
      animated: false,
      pages: 1,
      failOn: 'error',
    })
      .rotate()
      .resize({
        width: BLOG_IMAGE_OUTPUT_MAX_SIDE,
        height: BLOG_IMAGE_OUTPUT_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    throw new BadRequestException({ messageKey: BLOG_IMAGE_ERRORS.invalid });
  }
}

@Injectable()
export class BlogImagesService {
  constructor(
    @Inject(MEDIA_STORAGE_PROVIDER)
    private readonly storage: MediaStorageProvider,
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async upload(
    platformOwnerId: string,
    file: UploadedImageFile | undefined,
  ): Promise<BlogImageUploadResult> {
    if (!file?.buffer) {
      throw new BadRequestException({ messageKey: BLOG_IMAGE_ERRORS.invalid });
    }
    const image = await encodeBlogImage(file.buffer);
    const name = randomUUID();
    const key = `${BLOG_IMAGE_PREFIX}/${name}.webp`;
    await this.storage.putObject(key, image.data, 'image/webp');
    await this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
      this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        role: 'platform_owner',
        action: 'platform.blog_image.uploaded',
        targetType: 'platform_blog_image',
        targetId: name,
        context: {
          width: image.width,
          height: image.height,
          sizeBytes: image.data.length,
        },
      }),
    );
    return { url: toMediaAssetUrl(key), width: image.width, height: image.height };
  }
}
