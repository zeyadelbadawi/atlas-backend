/**
 * TenantUsageSweepCursorRepository — persists `SubscriptionSweepService`'s
 * stale-usage scan cursor ACROSS ticks (Phase 4.6 fix — see
 * `TenantUsageSweepCursor`'s own schema doc comment for the exact bug this
 * closes: a fresh `cursor` local on every `run()` call meant every tick
 * re-scanned from the beginning of the `organizations` table, so a stale
 * backlog past the per-tick ceiling was never actually drained).
 *
 * Platform-owned singleton, no RLS — same fixed-id-plus-`upsert` pattern as
 * `TrialPolicyRepository` (see that file's own doc comment for why upsert-
 * on-a-fixed-id, not find-then-create). That race-safety matters here
 * specifically because more than one backend instance's sweep worker may
 * read and write this one row concurrently under BullMQ horizontal
 * scaling — upsert closes it atomically at the database level.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/** Fixed, well-known id — never generated, never varies. The one row this table will ever have. Distinct from `TrialPolicyRepository`'s own singleton id. */
const SINGLETON_ID = '00000000-0000-0000-0000-000000000002';

@Injectable()
export class TenantUsageSweepCursorRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `undefined` means "start from the beginning of the id space" — either
   * no tick has ever run yet, or the most recent tick scanned all the way
   * to the real end of the `organizations` table and wrapped around.
   * Deliberately not run inside any tenant/user RLS context: this row
   * carries no tenant data and no RLS policy exists for it, exactly like
   * `TrialPolicyRepository`'s own direct `PrismaService` use.
   */
  async read(): Promise<string | undefined> {
    const row = await this.prisma.tenantUsageSweepCursor.findUnique({
      where: { id: SINGLETON_ID },
    });
    return row?.lastOrganizationId ?? undefined;
  }

  /**
   * Persists progress after each page the sweep processes — never batched
   * to write only once at tick-end — so a mid-tick failure (crash, a
   * `P2028` transaction timeout, a worker restart) never silently discards
   * already-completed progress and forces a redundant re-scan from the
   * previous checkpoint. Pass `null` to explicitly wrap around to the
   * beginning once the scan has reached the real end of the organizations
   * table.
   */
  async write(lastOrganizationId: string | null): Promise<void> {
    await this.prisma.tenantUsageSweepCursor.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, lastOrganizationId },
      update: { lastOrganizationId },
    });
  }
}
