/**
 * WebsiteTestimonialEntriesRepository — mirrors
 * `WebsiteFaqEntriesRepository` exactly (same shape, same "no hard-delete
 * method" rule). See that file's doc comment.
 */
import { Injectable } from '@nestjs/common';
import type {
  Prisma,
  WebsiteContentStatus,
  WebsiteTestimonialEntry,
} from '@prisma/client';

export interface WebsiteTestimonialEntryListFilter {
  readonly search?: string;
  readonly status?: WebsiteContentStatus;
  readonly skip: number;
  readonly take: number;
}

@Injectable()
export class WebsiteTestimonialEntriesRepository {
  findById(
    tx: Prisma.TransactionClient,
    academyId: string,
    id: string,
  ): Promise<WebsiteTestimonialEntry | null> {
    return tx.websiteTestimonialEntry.findFirst({ where: { id, academyId } });
  }

  findAllForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<WebsiteTestimonialEntry[]> {
    return tx.websiteTestimonialEntry.findMany({ where: { academyId } });
  }

  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    filter: WebsiteTestimonialEntryListFilter,
  ): Promise<{ items: WebsiteTestimonialEntry[]; totalItems: number }> {
    const where: Prisma.WebsiteTestimonialEntryWhereInput = {
      academyId,
      ...(filter.status ? { status: filter.status } : {}),
    };

    const [items, totalItems] = await Promise.all([
      tx.websiteTestimonialEntry.findMany({
        where,
        orderBy: { order: 'asc' },
        skip: filter.skip,
        take: filter.take,
      }),
      tx.websiteTestimonialEntry.count({ where }),
    ]);

    return { items, totalItems };
  }

  async nextOrder(tx: Prisma.TransactionClient, academyId: string): Promise<number> {
    const result = await tx.websiteTestimonialEntry.aggregate({
      where: { academyId },
      _max: { order: true },
    });
    return (result._max.order ?? -1) + 1;
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.WebsiteTestimonialEntryCreateInput,
  ): Promise<WebsiteTestimonialEntry> {
    return tx.websiteTestimonialEntry.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.WebsiteTestimonialEntryUpdateInput,
  ): Promise<WebsiteTestimonialEntry> {
    return tx.websiteTestimonialEntry.update({ where: { id }, data });
  }
}
