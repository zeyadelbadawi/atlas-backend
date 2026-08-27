/**
 * RevenueLedgerEntriesRepository — `revenue_ledger_entries` is append-only
 * (master plan §5.8) — this repository deliberately has no `update`/
 * `delete` method at all, matching the table's own "no UPDATE/DELETE RLS
 * policy exists" enforcement one layer up (defense in depth, not
 * redundancy — see every other repository in this codebase's identical
 * "RLS is never the only check" rule).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, RevenueLedgerEntry } from '@prisma/client';

@Injectable()
export class RevenueLedgerEntriesRepository {
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.RevenueLedgerEntryCreateInput,
  ): Promise<RevenueLedgerEntry> {
    return tx.revenueLedgerEntry.create({ data });
  }

  createMany(
    tx: Prisma.TransactionClient,
    data: readonly Prisma.RevenueLedgerEntryCreateManyInput[],
  ): Promise<Prisma.BatchPayload> {
    return tx.revenueLedgerEntry.createMany({ data: [...data] });
  }

  findManyForCourseOrder(
    tx: Prisma.TransactionClient,
    courseOrderId: string,
  ): Promise<RevenueLedgerEntry[]> {
    return tx.revenueLedgerEntry.findMany({
      where: { courseOrderId },
      orderBy: { occurredAt: 'asc' },
    });
  }

  /**
   * Every ledger entry for an Academy that has not yet been linked to an
   * `AcademyPayoutItem` — the exact set `PlatformAcademyPayoutsService`
   * settles into a new payout. Scoped to `occurredAt <= asOf` so a payout
   * run never settles an entry written concurrently, mid-computation,
   * after the period the caller intended to close.
   */
  findUnsettledForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    asOf: Date,
  ): Promise<RevenueLedgerEntry[]> {
    return tx.revenueLedgerEntry.findMany({
      where: { academyId, occurredAt: { lte: asOf }, payoutItems: { none: {} } },
      orderBy: { occurredAt: 'asc' },
    });
  }
}
