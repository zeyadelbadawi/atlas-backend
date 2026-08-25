/**
 * WebsiteFaqEntriesRepository — every method takes a
 * `Prisma.TransactionClient` obtained from
 * `TenancyContextService.runInTenantContext`, matching every other
 * repository in this codebase's established rule. No hard-delete method
 * exists here at all — archive is the only removal action (master plan
 * §21 P10).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, WebsiteContentStatus, WebsiteFaqEntry } from '@prisma/client';

export interface WebsiteFaqEntryListFilter {
  readonly search?: string;
  readonly status?: WebsiteContentStatus;
  readonly skip: number;
  readonly take: number;
}

@Injectable()
export class WebsiteFaqEntriesRepository {
  findById(
    tx: Prisma.TransactionClient,
    academyId: string,
    id: string,
  ): Promise<WebsiteFaqEntry | null> {
    return tx.websiteFaqEntry.findFirst({ where: { id, academyId } });
  }

  /** Every entry for an Academy, unpaginated — used for reference validation (`libraryEntryIds` existence checks), the same "small, bounded set, one query" approach `WebsitePagesRepository.findAllForAcademy` already established. */
  findAllForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<WebsiteFaqEntry[]> {
    return tx.websiteFaqEntry.findMany({ where: { academyId } });
  }

  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    filter: WebsiteFaqEntryListFilter,
  ): Promise<{ items: WebsiteFaqEntry[]; totalItems: number }> {
    const where: Prisma.WebsiteFaqEntryWhereInput = {
      academyId,
      ...(filter.status ? { status: filter.status } : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.websiteFaqEntry.findMany({
        where,
        orderBy: { order: 'asc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.websiteFaqEntry.count({ where }),
    ]);

    return { items, totalItems };
  }

  /** The next `order` value for a new entry in this Academy — appended to the end, matching `CreateWebsiteFaqEntryPayload`'s lack of an `order` field (the backend, not the client, owns initial placement). */
  async nextOrder(tx: Prisma.TransactionClient, academyId: string): Promise<number> {
    const result = await tx.websiteFaqEntry.aggregate({
      where: { academyId },
      _max: { order: true },
    });
    return (result._max.order ?? -1) + 1;
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.WebsiteFaqEntryCreateInput,
  ): Promise<WebsiteFaqEntry> {
    return tx.websiteFaqEntry.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.WebsiteFaqEntryUpdateInput,
  ): Promise<WebsiteFaqEntry> {
    return tx.websiteFaqEntry.update({ where: { id }, data });
  }
}
