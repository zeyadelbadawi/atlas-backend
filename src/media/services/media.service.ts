/**
 * MediaService — matches `MediaService` (atlas frontend) exactly:
 * `getAssets`/`getAsset`/`uploadAsset`/`updateAsset`/`archiveAsset`, no
 * more, no fewer (master plan §21 P8's own instruction: "if the frontend
 * does not have a method, do not invent it").
 *
 * Every method independently re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantContext`, matching every other
 * service in this codebase's "never trust the guard's own read"
 * discipline — `AcademyScopeGuard` (reused verbatim, unmodified) already
 * proved organization membership before any of these run.
 *
 * Write authorization mirrors `CoursesService.assertCanManage` exactly:
 * organization membership alone is READ-sufficient (governed entirely by
 * `AcademyScopeGuard`), but WRITE (upload/update/archive) requires an
 * `academy_members` row with role `owner`/`administrator` — no new
 * permission entity, no invented role (master plan §9/§21's explicit
 * instruction).
 *
 * Upload pipeline (master plan §11): DTO validation already happened at
 * the controller boundary; this method does everything after — parse the
 * data URL, verify the real file kind from its actual bytes (never the
 * claimed `mimeType`), enforce the real size ceiling from the real
 * decoded buffer (never the claimed `sizeBytes`), generate a safe
 * backend-only storage key, upload to R2, persist metadata, enqueue async
 * dimension extraction, and return the exact frontend contract.
 */
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { MediaAssetsRepository } from '../repositories/media-assets.repository';
import { MEDIA_STORAGE_PROVIDER } from '../storage/media-storage.interface';
import type { MediaStorageProvider } from '../storage/media-storage.interface';
import { MediaProcessingProducer } from '../queue/media-processing.producer';
import { EntitlementEnforcementService } from '../../plans/services/entitlement-enforcement.service';
import { TenantUsageRecomputeProducer } from '../../plans/queue/tenant-usage-recompute.producer';
import { toMediaAssetResponse } from '../dto/media-asset.contract';
import type { MediaAssetResponse } from '../dto/media-asset.contract';
import type { UploadMediaAssetDto } from '../dto/upload-media-asset.dto';
import type { UpdateMediaAssetDto } from '../dto/update-media-asset.dto';
import type { MediaListQueryDto } from '../dto/media-list-query.dto';
import {
  assertWithinSizeLimit,
  buildStorageKey,
  detectFileKind,
  parseDataUrl,
  sanitizeFileName,
} from '../utils/file-validation.util';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { MediaStorageConfig } from '../../config/configuration';
import type { Prisma } from '@prisma/client';

const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

@Injectable()
export class MediaService {
  private readonly storageConfig: MediaStorageConfig;

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly mediaAssetsRepository: MediaAssetsRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly mediaProcessingProducer: MediaProcessingProducer,
    private readonly entitlementEnforcementService: EntitlementEnforcementService,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
    @Inject(MEDIA_STORAGE_PROVIDER)
    private readonly storageProvider: MediaStorageProvider,
    configService: ConfigService,
  ) {
    this.storageConfig = configService.getOrThrow<MediaStorageConfig>('media');
  }

  private async assertCanManage(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (!membership || !MANAGING_ROLES.has(membership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.media.insufficientRole' });
    }
  }

  async list(
    academyId: string,
    organizationId: string,
    query: MediaListQueryDto,
  ): Promise<PaginatedResult<MediaAssetResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.mediaAssetsRepository.findManyForAcademy(tx, academyId, {
          search: query.search,
          status: query.status,
          type: query.type,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toMediaAssetResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getById(
    academyId: string,
    organizationId: string,
    assetId: string,
  ): Promise<MediaAssetResponse> {
    const asset = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.mediaAssetsRepository.findById(tx, academyId, assetId),
    );
    if (!asset) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toMediaAssetResponse(asset);
  }

  async upload(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UploadMediaAssetDto,
  ): Promise<MediaAssetResponse> {
    const { buffer } = parseDataUrl(payload.dataUrl);
    assertWithinSizeLimit(buffer, this.storageConfig.maxUploadBytes);

    const kind = detectFileKind(buffer);
    if (!kind) {
      throw new BadRequestException({ messageKey: 'errors.media.unsupportedFileType' });
    }

    // Authorization, THEN the live storage-entitlement check — both
    // before any real storage I/O, so an unauthorized OR over-limit
    // caller can never cause a real R2 upload, even one whose DB write
    // will ultimately be rejected (extends this method's own pre-existing
    // "authorization first" rule to Phase 2's new entitlement check).
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      await this.entitlementEnforcementService.assertStorageWithinLimit(
        tx,
        organizationId,
        kind.assetType === 'video' ? 'videoStorage' : 'generalStorage',
        buffer.length,
      );
    });

    const id = randomUUID();
    const storageKey = buildStorageKey(academyId, kind.extension, id);
    const { url } = await this.storageProvider.putObject(
      storageKey,
      buffer,
      kind.mimeType,
    );

    const asset = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.mediaAssetsRepository.create(tx, {
          id,
          academy: { connect: { id: academyId } },
          type: kind.assetType,
          fileName: sanitizeFileName(payload.fileName),
          storageKey,
          url,
          altText: payload.altText,
          mimeType: kind.mimeType,
          sizeBytes: BigInt(buffer.length),
        }),
    );

    await this.mediaProcessingProducer.enqueue(asset.id, academyId, organizationId);
    // Phase 2 — real reactive usage-recompute trigger (a storage change).
    await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);

    return toMediaAssetResponse(asset);
  }

  async update(
    academyId: string,
    organizationId: string,
    userId: string,
    assetId: string,
    payload: UpdateMediaAssetDto,
  ): Promise<MediaAssetResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const existing = await this.mediaAssetsRepository.findById(tx, academyId, assetId);
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const updated = await this.mediaAssetsRepository.update(tx, assetId, {
        altText: payload.altText,
      });
      return toMediaAssetResponse(updated);
    });
  }

  async archive(
    academyId: string,
    organizationId: string,
    userId: string,
    assetId: string,
  ): Promise<MediaAssetResponse> {
    const response = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        const existing = await this.mediaAssetsRepository.findById(
          tx,
          academyId,
          assetId,
        );
        if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

        const updated = await this.mediaAssetsRepository.update(tx, assetId, {
          status: 'archived',
        });
        return toMediaAssetResponse(updated);
      },
    );

    // Phase 2 — an archived asset frees its storage footprint — real
    // reactive usage-recompute trigger.
    await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);

    return response;
  }
}
