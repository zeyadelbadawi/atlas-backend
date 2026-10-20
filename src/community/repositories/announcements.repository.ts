/**
 * AnnouncementsRepository — every method takes a `Prisma.TransactionClient`
 * obtained from `TenancyContextService.runInUserContext`, matching every
 * other repository in this codebase's established rule. Relies entirely
 * on the P7 migration's RLS policies to shape what each query can actually
 * see — `findFeed`/`findManyForCourse` issue the same plain query, and the
 * different visible rows come from which policy the caller's real facts
 * satisfy, never a `WHERE` clause re-deriving authorization here.
 */
import { Injectable } from '@nestjs/common';
import type { Announcement, AnnouncementStatus, Prisma } from '@prisma/client';

export type AnnouncementWithAuthor = Announcement & { author: { name: string } };

const WITH_AUTHOR = { author: { select: { name: true } } } as const;

/** One row `publishDueScheduled` flipped to `published` on this call. */
export interface ScheduledAnnouncementPublished {
  readonly id: string;
  readonly academyId: string | null;
  readonly courseId: string | null;
  readonly authorId: string;
  readonly publishedAt: Date;
}

@Injectable()
export class AnnouncementsRepository {
  async findFeed(
    tx: Prisma.TransactionClient,
    options: { skip: number; take: number },
  ): Promise<{ items: AnnouncementWithAuthor[]; totalItems: number }> {
    const where: Prisma.AnnouncementWhereInput = { status: 'published' };
    const [items, totalItems] = await Promise.all([
      tx.announcement.findMany({
        where,
        include: WITH_AUTHOR,
        orderBy: { publishedAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      tx.announcement.count({ where }),
    ]);
    return { items, totalItems };
  }

  findById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<AnnouncementWithAuthor | null> {
    return tx.announcement.findUnique({ where: { id }, include: WITH_AUTHOR });
  }

  async findManyForCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: AnnouncementWithAuthor[]; totalItems: number }> {
    const where: Prisma.AnnouncementWhereInput = { courseId };
    const [items, totalItems] = await Promise.all([
      tx.announcement.findMany({
        where,
        include: WITH_AUTHOR,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      tx.announcement.count({ where }),
    ]);
    return { items, totalItems };
  }

  /** Academy-wide authoring's own list, matching `findManyForCourse` exactly — `courseId: null` excludes that academy's own course-scoped announcements, which have their own separate authoring surface. */
  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: AnnouncementWithAuthor[]; totalItems: number }> {
    const where: Prisma.AnnouncementWhereInput = { academyId, courseId: null };
    const [items, totalItems] = await Promise.all([
      tx.announcement.findMany({
        where,
        include: WITH_AUTHOR,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      tx.announcement.count({ where }),
    ]);
    return { items, totalItems };
  }

  /** Platform-wide authoring's own list — every `audience: 'platform'` row, regardless of status, meaningful only inside `runInUserContext(<a real platform-owner id>)` (`announcements_platform_manage_select`). */
  async findManyForPlatform(
    tx: Prisma.TransactionClient,
    options: { skip: number; take: number },
  ): Promise<{ items: AnnouncementWithAuthor[]; totalItems: number }> {
    const where: Prisma.AnnouncementWhereInput = { audience: 'platform' };
    const [items, totalItems] = await Promise.all([
      tx.announcement.findMany({
        where,
        include: WITH_AUTHOR,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      tx.announcement.count({ where }),
    ]);
    return { items, totalItems };
  }

  /**
   * Phase 6 — the Phase 2 sweep tick's own "publish due scheduled content"
   * step (see `SubscriptionSweepService.run`). Meaningful only inside
   * `runInUserContext(<a real platform-owner id>)`: the
   * `announcements_platform_schedule_select/update` bypass policies (P27
   * migration) are what let this single `updateMany` reach every due row
   * platform-wide, regardless of which academy/course it belongs to — this
   * query itself carries no cross-tenant special-casing of its own.
   *
   * Returns the rows THIS call published, so the caller can fan them out
   * exactly like an immediate publish (a scheduled announcement used to
   * publish to no one). Each row is flipped by its own conditional
   * update, so two overlapping ticks never both report the same row.
   */
  async publishDueScheduled(
    tx: Prisma.TransactionClient,
    asOf: Date,
  ): Promise<ScheduledAnnouncementPublished[]> {
    const due = await tx.announcement.findMany({
      where: { status: 'scheduled', scheduledAt: { lte: asOf } },
      select: { id: true, academyId: true, courseId: true, authorId: true },
    });
    const published: ScheduledAnnouncementPublished[] = [];
    for (const row of due) {
      const { count } = await tx.announcement.updateMany({
        where: { id: row.id, status: 'scheduled' },
        data: { status: 'published', publishedAt: asOf },
      });
      if (count === 1) published.push({ ...row, publishedAt: asOf });
    }
    return published;
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.AnnouncementCreateInput,
  ): Promise<AnnouncementWithAuthor> {
    return tx.announcement.create({ data, include: WITH_AUTHOR });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.AnnouncementUpdateInput,
  ): Promise<AnnouncementWithAuthor> {
    return tx.announcement.update({ where: { id }, data, include: WITH_AUTHOR });
  }

  /**
   * `update`, but only while the row still has the status the caller read.
   * A schedule change decides the new status from the one it read; without
   * this the sweep could publish the row in between and the write would put
   * it back to `scheduled` (and publish it twice). `null` when the status
   * moved on.
   */
  async updateIfStatus(
    tx: Prisma.TransactionClient,
    id: string,
    expectedStatus: AnnouncementStatus,
    data: Prisma.AnnouncementUncheckedUpdateManyInput,
  ): Promise<AnnouncementWithAuthor | null> {
    const { count } = await tx.announcement.updateMany({
      where: { id, status: expectedStatus },
      data,
    });
    return count === 0 ? null : this.findById(tx, id);
  }
}
