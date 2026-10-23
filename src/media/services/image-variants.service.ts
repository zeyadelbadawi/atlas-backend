/**
 * CMS phase 4 — generates and records an asset's responsive variants
 * (`image-variants.util.ts`). Shared by the media worker (every new upload)
 * and the backfill (`src/scripts/backfill-image-variants.ts`).
 *
 * BEST-EFFORT BY CONTRACT. Nothing here may fail an upload or a worker
 * job: a failure is logged and reported as `'failed'`, `variants` stays
 * NULL, and the public route keeps serving the original. Order matters:
 * every object is stored BEFORE the row lists it, so the route never
 * points at a variant that does not exist. Re-running overwrites the same
 * derived keys, so it is idempotent.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MediaAsset, Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { MediaAssetsRepository } from '../repositories/media-assets.repository';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../storage/media-storage.interface';
import {
  IMAGE_VARIANT_CONTENT_TYPES,
  generateImageVariants,
  imageVariantKey,
  isVariantEligible,
  type ImageVariant,
} from '../utils/image-variants.util';

export type ImageVariantsOutcome = 'generated' | 'none' | 'skipped' | 'failed';

@Injectable()
export class ImageVariantsService {
  private readonly logger = new Logger(ImageVariantsService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly mediaAssetsRepository: MediaAssetsRepository,
    @Inject(MEDIA_STORAGE_PROVIDER)
    private readonly storage: MediaStorageProvider,
  ) {}

  /**
   * `'generated'`: variants stored and recorded; `'none'`: eligible but
   * nothing to make (animated, unreadable size) — recorded as `[]` so the
   * backfill does not revisit it; `'skipped'`: not eligible; `'failed'`:
   * logged, nothing recorded.
   */
  async generateForAsset(
    asset: Pick<
      MediaAsset,
      'id' | 'type' | 'access' | 'provider' | 'mimeType' | 'storageKey'
    >,
    organizationId: string,
    originalBytes?: Buffer,
  ): Promise<ImageVariantsOutcome> {
    if (!isVariantEligible(asset)) return 'skipped';
    try {
      const bytes = originalBytes ?? (await this.storage.getObject(asset.storageKey));
      const generated = await generateImageVariants(bytes);
      const recorded: ImageVariant[] = [];
      for (const variant of generated) {
        await this.storage.putObject(
          imageVariantKey(asset.storageKey, variant.width, variant.format),
          variant.body,
          IMAGE_VARIANT_CONTENT_TYPES[variant.format],
        );
        recorded.push({
          width: variant.width,
          height: variant.height,
          format: variant.format,
          sizeBytes: variant.sizeBytes,
        });
      }
      await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
        this.mediaAssetsRepository.update(tx, asset.id, {
          variants: recorded as unknown as Prisma.InputJsonValue,
        }),
      );
      return recorded.length > 0 ? 'generated' : 'none';
    } catch (error) {
      this.logger.warn(
        { mediaAssetId: asset.id, error: (error as Error).message },
        'Image variants could not be generated; the original keeps serving.',
      );
      return 'failed';
    }
  }
}
