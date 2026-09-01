/**
 * TrialPolicyRepository — `trial_policy` is a PLATFORM-owned singleton, no
 * RLS. "Exactly one logical row ever exists" (master plan §5.6) is
 * enforced via a fixed, well-known id (`SINGLETON_ID`) and `upsert`,
 * rather than a find-then-create pattern — find-then-create has a real
 * race window under concurrent first-reads (two requests both seeing "no
 * row" and both creating one), which `upsert` on a fixed id closes
 * atomically at the database level, not by discipline.
 */
import { Injectable } from '@nestjs/common';
import type { TrialPolicy } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/** Fixed, well-known id — never generated, never varies. The one row this table will ever have. */
const SINGLETON_ID = '00000000-0000-0000-0000-000000000001';

const DEFAULT_ENABLED = true;
/** Phase 2, Decision 6 (locked): exactly 3 days, no credit card — supersedes the previous 7-day default. */
const DEFAULT_DURATION_DAYS = 3;

@Injectable()
export class TrialPolicyRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads the singleton, creating it with the frontend's own
   * `DEFAULT_TRIAL_POLICY` values on first-ever read — matching what the
   * UI would have shown as its own `initialData` fallback, so the very
   * first real response a caller ever sees is consistent with it.
   */
  findSingleton(): Promise<TrialPolicy> {
    return this.prisma.trialPolicy.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        enabled: DEFAULT_ENABLED,
        durationDays: DEFAULT_DURATION_DAYS,
      },
      update: {},
    });
  }

  update(enabled: boolean, durationDays: number): Promise<TrialPolicy> {
    return this.prisma.trialPolicy.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, enabled, durationDays },
      update: { enabled, durationDays },
    });
  }
}
