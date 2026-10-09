/**
 * MediaService — matches `MediaService` (atlas frontend) exactly:
 * `getAssets`/`getAsset`/`uploadAsset`/`updateAsset`/`archiveAsset`, no
 * more, no fewer (master plan §21 P8's own instruction: "if the frontend
 * does not have a method, do not invent it"). W1 removed the Phase 4
 * `uploadForSubmission`, which wrote learners' submission attachments
 * into this PUBLIC bucket; it had been unused since P64 Phase 3 moved
 * them to the protected tier (`ProtectedMediaService.uploadSubmissionAttachment`),
 * and leaving a public write path for learner files was a standing risk.
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
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { findMediaUsages, type MediaUsage } from './media-usage.util';
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
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';

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
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {
    this.storageConfig = configService.getOrThrow<MediaStorageConfig>('media');
  }

  /** Returns the caller's academy role, which the audit row records (no second lookup). */
  private async assertCanManage(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<string> {
    const role = await this.academyMembersRepository.findManagingRole(
      tx,
      academyId,
      userId,
      MANAGING_ROLES,
    );
    if (!role) {
      throw new ForbiddenException({ messageKey: 'errors.media.insufficientRole' });
    }
    return role;
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
    const { buffer, kind } = this.parseAndValidate(payload);

    // Authorization, THEN the live storage-entitlement check — both
    // before any real storage I/O, so an unauthorized OR over-limit
    // caller can never cause a real R2 upload, even one whose DB write
    // will ultimately be rejected (extends this method's own pre-existing
    // "authorization first" rule to Phase 2's new entitlement check).
    const role = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const callerRole = await this.assertCanManage(tx, academyId, userId);
        await this.entitlementEnforcementService.assertStorageWithinLimit(
          tx,
          organizationId,
          kind.assetType === 'video' ? 'videoStorage' : 'generalStorage',
          buffer.length,
        );
        return callerRole;
      },
    );

    // Task 3 — only a STAFF library upload is audited; an automated
    // recording import is not academy administration.
    return this.performUpload(academyId, organizationId, payload, buffer, kind, {
      actorUserId: userId,
      role,
    });
  }

  /**
   * Phase 12 — imports bytes Atlas fetched itself (a Zoom session
   * recording) into the academy's existing media library.
   *
   * The second entry point beside `upload`. It exists because the CALLER
   * has already
   * done its own authorization, and everything after that — the storage
   * write, the `MediaAsset` row, the processing enqueue, the usage
   * recompute — must be IDENTICAL, so an imported recording becomes a
   * real, quota-counted asset visible in the Media Library like any other
   * upload. A second storage path for recordings would be exactly the
   * parallel media library this must not become.
   *
   * NO USER AUTHORIZATION CHECK HERE, deliberately: the caller is the
   * webhook worker acting on a provider event, with no signed-in user.
   * Its authority comes from the verified provider signature and from the
   * session's own academy, both established before this is reached. The
   * storage-entitlement check below still runs, because an academy out of
   * storage must not be pushed over by an automated import.
   */
  async importFromBuffer(
    academyId: string,
    organizationId: string,
    input: {
      readonly buffer: Buffer;
      readonly fileName: string;
      readonly altText?: string;
    },
  ): Promise<MediaAssetResponse> {
    assertWithinSizeLimit(input.buffer, this.storageConfig.maxUploadBytes);

    const kind = detectFileKind(input.buffer);
    if (!kind) {
      throw new BadRequestException({ messageKey: 'errors.media.unsupportedFileType' });
    }

    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      this.entitlementEnforcementService.assertStorageWithinLimit(
        tx,
        organizationId,
        kind.assetType === 'video' ? 'videoStorage' : 'generalStorage',
        input.buffer.length,
      ),
    );

    return this.performUpload(
      academyId,
      organizationId,
      { fileName: input.fileName, altText: input.altText } as UploadMediaAssetDto,
      input.buffer,
      kind,
    );
  }

  private parseAndValidate(payload: UploadMediaAssetDto): {
    buffer: Buffer;
    kind: NonNullable<ReturnType<typeof detectFileKind>>;
  } {
    const { buffer } = parseDataUrl(payload.dataUrl, this.storageConfig.maxUploadBytes);

    const kind = detectFileKind(buffer);
    if (!kind) {
      throw new BadRequestException({ messageKey: 'errors.media.unsupportedFileType' });
    }
    return { buffer, kind };
  }

  /** The real storage write + metadata persistence, shared verbatim by `upload` and `importFromBuffer` — every caller has already finished its OWN authorization/entitlement check before this runs. */
  private async performUpload(
    academyId: string,
    organizationId: string,
    payload: UploadMediaAssetDto,
    buffer: Buffer,
    kind: NonNullable<ReturnType<typeof detectFileKind>>,
    audit?: { readonly actorUserId: string; readonly role: string },
  ): Promise<MediaAssetResponse> {
    const id = randomUUID();
    const storageKey = buildStorageKey(academyId, kind.extension, id);
    const { url } = await this.storageProvider.putObject(
      storageKey,
      buffer,
      kind.mimeType,
    );

    const asset = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const created = await this.mediaAssetsRepository.create(tx, {
          id,
          academy: { connect: { id: academyId } },
          type: kind.assetType,
          fileName: sanitizeFileName(payload.fileName),
          storageKey,
          url,
          altText: payload.altText,
          mimeType: kind.mimeType,
          sizeBytes: BigInt(buffer.length),
        });
        if (audit) {
          await this.auditLogWriterService.record(tx, {
            actorUserId: audit.actorUserId,
            organizationId,
            academyId,
            role: audit.role,
            action: 'media.uploaded',
            targetId: created.id,
            targetLabel: created.fileName,
            context: { mediaType: created.type, sizeBytes: buffer.length },
          });
        }
        return created;
      },
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

  /**
   * "Delete" in the product = archive now, destroy after the 30-day grace
   * (`ArchivedMediaPurgeService`). Owner/manager of THIS academy only
   * (`assertCanManage`); tenant RLS bounds every read and write. Refused
   * with 409 `errors.media.inUse` while anything still points at the asset
   * (see `media-usage.util.ts`), so no lesson, page or learner record is
   * silently broken. Archiving an already-archived asset is a no-op.
   */
  async archive(
    academyId: string,
    organizationId: string,
    userId: string,
    assetId: string,
  ): Promise<MediaAssetResponse> {
    const response = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId);
        return this.archiveOne(tx, academyId, assetId, {
          actorUserId: userId,
          organizationId,
          role,
        });
      },
    );

    // Phase 2 — an archived asset frees its storage footprint — real
    // reactive usage-recompute trigger.
    await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);

    return response;
  }

  /**
   * Bulk delete (archive). Every item is decided independently and
   * reported: archived, refused because it is in use (with its usages), or
   * not found in this academy. One authorization check for the batch; each
   * item in its own transaction so one refusal never rolls back the rest.
   */
  async archiveMany(
    academyId: string,
    organizationId: string,
    userId: string,
    assetIds: readonly string[],
  ): Promise<MediaBulkArchiveResponse> {
    const role = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.assertCanManage(tx, academyId, userId),
    );
    const archived: string[] = [];
    const refused: MediaBulkArchiveResponse['refused'][number][] = [];
    for (const assetId of new Set(assetIds)) {
      try {
        await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
          this.archiveOne(tx, academyId, assetId, {
            actorUserId: userId,
            organizationId,
            role,
          }),
        );
        archived.push(assetId);
      } catch (error) {
        if (error instanceof ConflictException) {
          const body = error.getResponse() as { details?: { usages?: MediaUsage[] } };
          refused.push({
            id: assetId,
            reason: 'inUse',
            usages: body.details?.usages ?? [],
          });
        } else if (error instanceof NotFoundException) {
          refused.push({ id: assetId, reason: 'notFound', usages: [] });
        } else {
          throw error;
        }
      }
    }
    if (archived.length > 0) {
      await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);
    }
    return { archived, refused };
  }

  private async archiveOne(
    tx: Prisma.TransactionClient,
    academyId: string,
    assetId: string,
    audit: {
      readonly actorUserId: string;
      readonly organizationId: string;
      readonly role: string;
    },
  ): Promise<MediaAssetResponse> {
    const existing = await this.mediaAssetsRepository.findById(tx, academyId, assetId);
    if (!existing || existing.status === 'deleted') {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    if (existing.status === 'archived') return toMediaAssetResponse(existing);
    const usages = await findMediaUsages(tx, existing);
    if (usages.length > 0) {
      throw new ConflictException({
        messageKey: 'errors.media.inUse',
        details: { usages },
      });
    }
    const updated = await this.mediaAssetsRepository.update(tx, assetId, {
      status: 'archived',
    });
    // Task 3 — one row per archived asset, in that asset's own transaction
    // (an already-archived asset returned above writes nothing).
    await this.auditLogWriterService.record(tx, {
      actorUserId: audit.actorUserId,
      organizationId: audit.organizationId,
      academyId,
      role: audit.role,
      action: 'media.archived',
      targetId: assetId,
      targetLabel: existing.fileName,
      context: { mediaType: existing.type },
    });
    return toMediaAssetResponse(updated);
  }
}

export interface MediaBulkArchiveResponse {
  readonly archived: readonly string[];
  readonly refused: readonly {
    readonly id: string;
    readonly reason: 'inUse' | 'notFound';
    readonly usages: readonly MediaUsage[];
  }[];
}
