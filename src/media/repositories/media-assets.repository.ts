/**
 * MediaAssetsRepository — every method takes a `Prisma.TransactionClient`
 * obtained from `TenancyContextService.runInTenantContext` (the exact
 * org-scoped context `AcademyScopeGuard` already established), matching
 * every other repository in this codebase's established rule. Tenant
 * scope is never implicit — every method receives `academyId` explicitly
 * (master plan §24 "Every repository operation must receive explicit
 * academy/tenant context").
 */
import { Injectable } from '@nestjs/common';
import type {
  MediaAsset,
  MediaAssetStatus,
  MediaAssetType,
  Prisma,
} from '@prisma/client';

export interface MediaAssetListFilter {
  readonly search?: string;
  readonly status?: MediaAssetStatus;
  readonly type?: MediaAssetType;
  readonly skip: number;
  readonly take: number;
}

@Injectable()
export class MediaAssetsRepository {
  findById(
    tx: Prisma.TransactionClient,
    academyId: string,
    id: string,
  ): Promise<MediaAsset | null> {
    return tx.mediaAsset.findFirst({ where: { id, academyId } });
  }

  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    filter: MediaAssetListFilter,
  ): Promise<{ items: MediaAsset[]; totalItems: number }> {
    const where: Prisma.MediaAssetWhereInput = {
      academyId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.search
        ? { fileName: { contains: filter.search, mode: 'insensitive' as const } }
        : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.mediaAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.mediaAsset.count({ where }),
    ]);

    return { items, totalItems };
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.MediaAssetCreateInput,
  ): Promise<MediaAsset> {
    return tx.mediaAsset.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.MediaAssetUpdateInput,
  ): Promise<MediaAsset> {
    return tx.mediaAsset.update({ where: { id }, data });
  }
}
