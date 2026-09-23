/** PaymentMethodsRepository — `payment_methods` is a PLATFORM-owned catalog table, no RLS, no tenant context (mirrors `PlansRepository`'s established precedent exactly). */
import { Injectable } from '@nestjs/common';
import type { PaymentMethod } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class PaymentMethodsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAllEnabled(): Promise<PaymentMethod[]> {
    return this.prisma.paymentMethod.findMany({
      where: { enabled: true },
      orderBy: { displayOrder: 'asc' },
    });
  }

  /**
   * Phase 4.5.3 (scalability, Change 4) — `findAllEnabled` kept untouched
   * (same "additive, not replacing" precedent as `PlansRepository.
   * findManyPaginated`); `PaymentService.getPaymentMethods` now calls
   * this instead. Same unpaginated-listing defect as `plans` (1,272 rows
   * in this dev database at the time of writing — accumulated e2e-test
   * fixtures, the identical root cause documented in `ATLAS_
   * SCALABILITY_ARCHITECTURE_PLAN.md`).
   *
   * `orderBy` breaks `displayOrder` ties with `createdAt`/`id` — same
   * reasoning as `PlansRepository.findManyPaginated`'s identical
   * tiebreak: `displayOrder` defaults to `0` and every fixture row in
   * this dev database leaves it at that default, so an untiebroken sort
   * gives Postgres no deterministic page boundary.
   */
  async findManyEnabledPaginated(
    skip: number,
    take: number,
  ): Promise<{ items: PaymentMethod[]; totalItems: number }> {
    const where = { enabled: true };
    const [items, totalItems] = await Promise.all([
      this.prisma.paymentMethod.findMany({
        where,
        orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        skip,
        take,
      }),
      this.prisma.paymentMethod.count({ where }),
    ]);
    return { items, totalItems };
  }

  /**
   * P64 Phase 4 — the learner checkout's method list.
   *
   * Filtered by provider in SQL rather than in the caller because the
   * only providers a learner may ever be offered are the one their
   * academy's payment settings resolve to; a caller-side filter over
   * `findAllEnabled()` would read the whole catalog (1,272 fixture rows
   * in this dev database, see `findManyEnabledPaginated`) to keep a
   * handful. Ordering matches the catalog's own `displayOrder`, so the
   * learner sees methods in the order the platform intends.
   */
  findAllEnabledByProvider(provider: string): Promise<PaymentMethod[]> {
    return this.prisma.paymentMethod.findMany({
      where: { enabled: true, provider },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  findByKey(key: string): Promise<PaymentMethod | null> {
    return this.prisma.paymentMethod.findUnique({ where: { key } });
  }
}
