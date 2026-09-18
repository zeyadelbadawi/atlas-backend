/**
 * DomainProviderReleasesRepository (P63g) — the ledger of provider
 * resources Atlas has given up and must delete at the provider. Rows are
 * written inside the transaction that gives the hostname up (tenant or
 * platform context), and processed under the platform context by the
 * post-commit attempt and by the verification sweep.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DomainProviderRelease } from '@prisma/client';
import type {
  DomainReleaseOutcome,
  DomainReleaseReason,
} from '../constants/domain.constants';

export interface EnqueueReleaseInput {
  readonly academyId: string;
  readonly hostname: string;
  readonly providerHostnameId: string | null;
  readonly reason: DomainReleaseReason;
}

/** Retry schedule for a release that failed: doubling from one minute, capped at six hours. Never gives up — an orphan at the edge is never acceptable. */
export function releaseRetryDelayMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.min(attempts, 9), 6 * 60 * 60 * 1000);
}

@Injectable()
export class DomainProviderReleasesRepository {
  enqueue(
    tx: Prisma.TransactionClient,
    input: EnqueueReleaseInput,
  ): Promise<DomainProviderRelease> {
    return tx.domainProviderRelease.create({
      data: {
        academyId: input.academyId,
        hostname: input.hostname,
        providerHostnameId: input.providerHostnameId,
        reason: input.reason,
      },
    });
  }

  findById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<DomainProviderRelease | null> {
    return tx.domainProviderRelease.findUnique({ where: { id } });
  }

  /** Pending rows that are due for another attempt, oldest first. */
  async findDue(
    tx: Prisma.TransactionClient,
    now: Date,
    take: number,
  ): Promise<DomainProviderRelease[]> {
    const candidates = await tx.domainProviderRelease.findMany({
      where: { releasedAt: null },
      orderBy: [{ createdAt: 'asc' }],
      take: take * 4,
    });
    return candidates
      .filter(
        (row) =>
          !row.lastAttemptedAt ||
          row.lastAttemptedAt.getTime() + releaseRetryDelayMs(row.attempts) <=
            now.getTime(),
      )
      .slice(0, take);
  }

  countPending(tx: Prisma.TransactionClient): Promise<number> {
    return tx.domainProviderRelease.count({ where: { releasedAt: null } });
  }

  markReleased(
    tx: Prisma.TransactionClient,
    id: string,
    outcome: DomainReleaseOutcome,
    at: Date,
  ): Promise<DomainProviderRelease> {
    return tx.domainProviderRelease.update({
      where: { id },
      data: {
        releasedAt: at,
        outcome,
        lastAttemptedAt: at,
        lastError: null,
        attempts: { increment: 1 },
      },
    });
  }

  markFailed(
    tx: Prisma.TransactionClient,
    id: string,
    error: string,
    at: Date,
  ): Promise<DomainProviderRelease> {
    return tx.domainProviderRelease.update({
      where: { id },
      data: { lastAttemptedAt: at, lastError: error, attempts: { increment: 1 } },
    });
  }
}
