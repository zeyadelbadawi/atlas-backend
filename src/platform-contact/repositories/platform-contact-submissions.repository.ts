/**
 * PlatformContactSubmissionsRepository — every query against
 * `platform_contact_submissions`. Each method takes the caller's open
 * transaction; the caller decides the RLS context:
 *
 *   - `insertAnonymous` runs in a context-less transaction (the only
 *     context the table's INSERT policy admits). It uses `createMany`, not
 *     `create`, ON PURPOSE: `create` issues `INSERT ... RETURNING`, and
 *     PostgreSQL applies the table's SELECT policy to returned rows — which
 *     an anonymous caller, correctly, does not pass. The id is generated
 *     here so nothing needs to be read back.
 *   - everything else runs in a Platform Owner's user context, admitted by
 *     the `platform_contact_submissions_platform_*` policies.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  PlatformContactSubmission,
  PlatformContactSubmissionStatus,
  PlatformContactTopic,
  Prisma,
} from '@prisma/client';
import type { PlatformContactSortField } from '../dto/list-platform-contact-submissions-query.dto';

export interface InsertPlatformContactSubmission {
  readonly name: string;
  readonly email: string;
  readonly organizationName: string | null;
  readonly topic: PlatformContactTopic;
  readonly message: string;
  readonly locale: string;
  readonly sourcePath: string | null;
  readonly ipHash: string;
  readonly userAgent: string | null;
}

export interface FindPlatformContactSubmissionsOptions {
  readonly skip: number;
  readonly take: number;
  readonly search?: string;
  readonly status?: PlatformContactSubmissionStatus;
  readonly topic?: PlatformContactTopic;
  readonly from?: Date;
  readonly toExclusive?: Date;
  readonly sortBy?: PlatformContactSortField;
  readonly sortDirection?: 'asc' | 'desc';
}

@Injectable()
export class PlatformContactSubmissionsRepository {
  /** Returns the new row's id. See the file header for why no row is returned. */
  async insertAnonymous(
    tx: Prisma.TransactionClient,
    data: InsertPlatformContactSubmission,
  ): Promise<string> {
    const id = randomUUID();
    await tx.platformContactSubmission.createMany({ data: [{ id, ...data }] });
    return id;
  }

  /** One page, filtered and sorted in the database. Ties broken by `id` so paging is stable. */
  async findMany(
    tx: Prisma.TransactionClient,
    options: FindPlatformContactSubmissionsOptions,
  ): Promise<{ items: PlatformContactSubmission[]; totalItems: number }> {
    const search = options.search?.trim();
    const where: Prisma.PlatformContactSubmissionWhereInput = {
      ...(options.status ? { status: options.status } : {}),
      ...(options.topic ? { topic: options.topic } : {}),
      ...(options.from || options.toExclusive
        ? {
            createdAt: {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.toExclusive ? { lt: options.toExclusive } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { organizationName: { contains: search, mode: 'insensitive' } },
              { message: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const direction = options.sortDirection ?? 'desc';
    const [items, totalItems] = await Promise.all([
      tx.platformContactSubmission.findMany({
        where,
        orderBy: [{ [options.sortBy ?? 'createdAt']: direction }, { id: direction }],
        skip: options.skip,
        take: options.take,
      }),
      tx.platformContactSubmission.count({ where }),
    ]);
    return { items, totalItems };
  }

  async countByStatus(
    tx: Prisma.TransactionClient,
  ): Promise<Record<PlatformContactSubmissionStatus, number>> {
    const rows = await tx.platformContactSubmission.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const counts: Record<PlatformContactSubmissionStatus, number> = {
      new: 0,
      read: 0,
      archived: 0,
    };
    for (const row of rows) counts[row.status] = row._count._all;
    return counts;
  }

  findById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<PlatformContactSubmission | null> {
    return tx.platformContactSubmission.findUnique({ where: { id } });
  }

  /**
   * `readAt` records the FIRST time an operator read the enquiry: set when
   * it first leaves `new`, kept on later moves (archive, restore), and
   * cleared only when it is explicitly marked unread again.
   */
  updateStatus(
    tx: Prisma.TransactionClient,
    current: PlatformContactSubmission,
    status: PlatformContactSubmissionStatus,
    now: Date,
  ): Promise<PlatformContactSubmission> {
    const readAt = status === 'new' ? null : (current.readAt ?? now);
    return tx.platformContactSubmission.update({
      where: { id: current.id },
      data: { status, readAt },
    });
  }

  async delete(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.platformContactSubmission.delete({ where: { id } });
  }
}
