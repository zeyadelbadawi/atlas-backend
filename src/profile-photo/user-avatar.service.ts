/**
 * UserAvatarService — the account's own profile photo (`POST` / `DELETE
 * /users/me/avatar`). The photo belongs to the person, not to an academy,
 * so it is stored outside any academy's media library.
 *
 *  - Accepts PNG, JPEG or WebP decided from the BYTES (the blog image
 *    rules: magic numbers, a pixel limit against decompression bombs, one
 *    frame, EXIF rotation applied, metadata stripped — no location leaves
 *    the phone's photo).
 *  - Crops to a centred square and re-encodes as a 512 x 512 WebP: one
 *    size every screen can draw sharply, a few dozen kilobytes.
 *  - Stores it under `users/avatars/<uuid>.webp` and points `avatarUrl`
 *    at the site-relative URL `PublicMediaController` serves. A new name
 *    every time, so a cached copy of an old photo is never shown as the
 *    new one; the previous object is deleted.
 *
 * Additive: `PATCH /users/me {avatar}` still works as before.
 */
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import sharp, { type Metadata } from 'sharp';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../media/storage/media-storage.interface';
import { toMediaAssetUrl } from '../media/dto/media-asset.contract';
import { sniffBlogImageFormat } from '../blog/services/blog-images.service';
import { TenancyContextService } from '../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../audit-log/services/audit-log-writer.service';
import { UsersService } from '../identity/services/users.service';
import type { CurrentUserResponse } from '../identity/dto/contracts';

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_MAX_SIDE = 8000;
export const AVATAR_MAX_PIXELS = AVATAR_MAX_SIDE * AVATAR_MAX_SIDE;
export const AVATAR_SIZE = 512;
export const AVATAR_PREFIX = 'users/avatars';
const WEBP_QUALITY = 82;

/** `users/avatars/<uuid>.webp`; the public route accepts nothing else. */
export const AVATAR_FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.webp$/;

export const AVATAR_ERRORS = {
  invalid: 'errors.profile.avatarInvalid',
  tooLarge: 'errors.profile.avatarTooLarge',
} as const;

/** The parts of a multer file this service reads. */
export interface UploadedAvatarFile {
  readonly buffer: Buffer;
  readonly size: number;
}

/** Validates an upload and turns it into the 512 x 512 WebP that is kept. */
export async function encodeAvatar(bytes: Buffer): Promise<Buffer> {
  if (bytes.length === 0) {
    throw new BadRequestException({ messageKey: AVATAR_ERRORS.invalid });
  }
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new PayloadTooLargeException({ messageKey: AVATAR_ERRORS.tooLarge });
  }
  const format = sniffBlogImageFormat(bytes);
  if (!format) throw new BadRequestException({ messageKey: AVATAR_ERRORS.invalid });
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, {
      limitInputPixels: AVATAR_MAX_PIXELS,
      animated: false,
      pages: 1,
    }).metadata();
  } catch {
    throw new BadRequestException({ messageKey: AVATAR_ERRORS.invalid });
  }
  if (metadata.format !== format || !metadata.width || !metadata.height) {
    throw new BadRequestException({ messageKey: AVATAR_ERRORS.invalid });
  }
  try {
    return await sharp(bytes, {
      limitInputPixels: AVATAR_MAX_PIXELS,
      animated: false,
      pages: 1,
      failOn: 'error',
    })
      .rotate()
      .resize({
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        fit: 'cover',
        position: 'centre',
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
  } catch {
    throw new BadRequestException({ messageKey: AVATAR_ERRORS.invalid });
  }
}

/** The storage key behind one of our own avatar URLs, else `null`. */
export function avatarKeyOf(url: string | null | undefined): string | null {
  if (!url) return null;
  const prefix = `${toMediaAssetUrl(AVATAR_PREFIX)}/`;
  if (!url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length);
  return AVATAR_FILE_PATTERN.test(name) ? `${AVATAR_PREFIX}/${name}` : null;
}

@Injectable()
export class UserAvatarService {
  private readonly logger = new Logger(UserAvatarService.name);

  constructor(
    @Inject(MEDIA_STORAGE_PROVIDER)
    private readonly storage: MediaStorageProvider,
    private readonly usersService: UsersService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async upload(
    userId: string,
    file: UploadedAvatarFile | undefined,
  ): Promise<CurrentUserResponse> {
    if (!file?.buffer) {
      throw new BadRequestException({ messageKey: AVATAR_ERRORS.invalid });
    }
    const image = await encodeAvatar(file.buffer);
    const key = `${AVATAR_PREFIX}/${randomUUID()}.webp`;
    await this.storage.putObject(key, image, 'image/webp');
    const before = (await this.usersService.getCurrent(userId)).avatar;
    const user = await this.usersService.updateProfile(userId, {
      avatar: toMediaAssetUrl(key),
    });
    await this.audit(userId, 'account.avatar.updated', { sizeBytes: image.length });
    await this.removeObject(before);
    return user;
  }

  async remove(userId: string): Promise<CurrentUserResponse> {
    const before = (await this.usersService.getCurrent(userId)).avatar;
    const user = await this.usersService.clearAvatar(userId);
    if (before) await this.audit(userId, 'account.avatar.removed', {});
    await this.removeObject(before);
    return user;
  }

  /** Best effort: a left-over object is unreachable once no row points at it. */
  private async removeObject(url: string | null | undefined): Promise<void> {
    const key = avatarKeyOf(url);
    if (!key) return;
    try {
      await this.storage.deleteObject(key);
    } catch (error) {
      this.logger.warn(
        { key, error: error instanceof Error ? error.message : String(error) },
        'Could not delete a replaced avatar object.',
      );
    }
  }

  private async audit(
    userId: string,
    action: 'account.avatar.updated' | 'account.avatar.removed',
    context: Record<string, number>,
  ): Promise<void> {
    await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        action,
        targetType: 'user',
        targetId: userId,
        context,
      }),
    );
  }
}
