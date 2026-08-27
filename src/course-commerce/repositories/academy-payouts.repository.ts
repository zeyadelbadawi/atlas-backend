/** AcademyPayoutsRepository/AcademyPayoutItemsRepository — `academy_payouts`/`academy_payout_items` (master plan §5.8). Write access is Platform-Owner-only at RLS (see migration.sql); this repository does not re-implement that check. */
import { Injectable } from '@nestjs/common';
import type { AcademyPayout, AcademyPayoutItem, Prisma } from '@prisma/client';

const WITH_ITEMS = { items: true } satisfies Prisma.AcademyPayoutInclude;
type AcademyPayoutWithItems = AcademyPayout & { items: AcademyPayoutItem[] };

@Injectable()
export class AcademyPayoutsRepository {
  findById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<AcademyPayoutWithItems | null> {
    return tx.academyPayout.findUnique({ where: { id }, include: WITH_ITEMS });
  }

  findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: AcademyPayoutWithItems[]; totalItems: number }> {
    const where: Prisma.AcademyPayoutWhereInput = { academyId };
    return Promise.all([
      tx.academyPayout.findMany({
        where,
        include: WITH_ITEMS,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      tx.academyPayout.count({ where }),
    ]).then(([items, totalItems]) => ({ items, totalItems }));
  }

  findManyAnyAcademy(
    tx: Prisma.TransactionClient,
    options: { skip: number; take: number },
  ): Promise<{ items: AcademyPayoutWithItems[]; totalItems: number }> {
    return Promise.all([
      tx.academyPayout.findMany({
        include: WITH_ITEMS,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      tx.academyPayout.count(),
    ]).then(([items, totalItems]) => ({ items, totalItems }));
  }

  /**
   * `UncheckedCreateInput` (plain scalar `academyId`), not the relational
   * `CreateInput` — deliberately, same reasoning as
   * `CourseOrdersRepository.create`'s own doc comment: a Platform Owner is
   * never an Academy/Organization member, so a nested `academy: {connect}`
   * would RLS-fail its own pre-flight existence check even though the row
   * genuinely exists.
   */
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.AcademyPayoutUncheckedCreateInput,
  ): Promise<AcademyPayout> {
    return tx.academyPayout.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.AcademyPayoutUpdateInput,
  ): Promise<AcademyPayout> {
    return tx.academyPayout.update({ where: { id }, data });
  }
}

@Injectable()
export class AcademyPayoutItemsRepository {
  createMany(
    tx: Prisma.TransactionClient,
    data: readonly Prisma.AcademyPayoutItemCreateManyInput[],
  ): Promise<Prisma.BatchPayload> {
    return tx.academyPayoutItem.createMany({ data: [...data] });
  }
}
