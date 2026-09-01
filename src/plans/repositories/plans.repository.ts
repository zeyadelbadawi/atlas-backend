/**
 * PlansRepository — `plans` is a PLATFORM-owned catalog table, no RLS, no
 * tenant context (see the P4 migration's doc comment). Unlike every
 * tenant-scoped repository in this codebase, this one takes the raw
 * `PrismaService` directly, not a `Prisma.TransactionClient` from
 * `TenancyContextService` — there is no tenant context to establish for a
 * table every caller reads identically.
 */
import { Injectable } from '@nestjs/common';
import type { Plan } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class PlansRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Plan[]> {
    return this.prisma.plan.findMany({ orderBy: { displayOrder: 'asc' } });
  }

  findByKey(key: string): Promise<Plan | null> {
    return this.prisma.plan.findUnique({ where: { key } });
  }

  findById(id: string): Promise<Plan | null> {
    return this.prisma.plan.findUnique({ where: { id } });
  }

  /**
   * Phase 2 — the trial-tier Plan a brand-new Organization's subscription
   * is created against. No dedicated "trial plan" concept exists in this
   * schema (a trial is a subscription STATUS, `'trialing'`, not a
   * separate catalog entry) — matching the pre-existing dev seed's own
   * precedent (`seed.ts`'s `orgB` trialing subscription uses the plain
   * `starter` plan), the lowest-`displayOrder` active Plan is used: the
   * smallest entry point a real self-service signup should land on,
   * exactly the one a brand-new customer would be expected to start
   * evaluating from. `createdAt` (then `id`) breaks a `displayOrder` tie
   * deterministically — a real catalog assigns each Plan a distinct
   * `displayOrder` (see `seed.ts`: 1/2/3), so this only ever matters if
   * two Plans genuinely share one, and even then always resolves to the
   * SAME Plan on every call rather than whichever row Postgres happens to
   * return first.
   */
  findDefaultTrialPlan(): Promise<Plan | null> {
    return this.prisma.plan.findFirst({
      where: { status: 'active' },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
  }
}
