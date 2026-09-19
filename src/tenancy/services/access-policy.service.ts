/**
 * How many devices and concurrent learning sessions one learner may use
 * (master plan D4/D8, Phase 2 §D.7).
 *
 * Resolution is MOST-SPECIFIC-FIRST — academy, then plan, then platform —
 * and an academy row can never exceed the platform row's values. The
 * ceiling is applied here, in the resolver, rather than as a database
 * constraint on purpose: the platform maximum is itself an editable row,
 * and a CHECK constraint would have to be rewritten (and every existing
 * academy row re-validated) every time the platform changed its mind.
 * Clamping at read time means lowering the platform maximum takes effect
 * everywhere immediately, and raising it does not silently widen academies
 * that never asked for more.
 *
 * If no platform row exists at all the resolver falls back to the D4
 * defaults (2 devices, 1 session) rather than to "unlimited". A missing
 * policy row must never be the reason a limit stops being enforced — the
 * migration seeds the row precisely so this fallback is unreachable, and
 * it is here for the case where someone deletes it.
 *
 * LIVES IN `TenancyModule`, not `LearningModule`, for the reason
 * `AcademyStudentsRepository`'s own comment already records: sign-in needs
 * it, `IdentityModule` depends on `TenancyModule`, and the reverse would
 * be a cycle.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export interface ResolvedAccessPolicy {
  readonly maxDevices: number;
  readonly maxConcurrentSessions: number;
  /** Which row actually decided, so the Devices page and the audit trail can say. */
  readonly source: 'academy' | 'plan' | 'platform' | 'default';
}

/** D4's approved defaults. The last line of defence, not the normal path. */
export const DEFAULT_ACCESS_POLICY = {
  maxDevices: 2,
  maxConcurrentSessions: 1,
} as const;

@Injectable()
export class AccessPolicyService {
  async resolveForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    planKey?: string | null,
  ): Promise<ResolvedAccessPolicy> {
    const rows = await tx.accessPolicy.findMany({
      where: {
        OR: [
          { scope: 'academy', academyId },
          ...(planKey ? [{ scope: 'plan' as const, planKey }] : []),
          { scope: 'platform' as const },
        ],
      },
    });

    const platform = rows.find((row) => row.scope === 'platform');
    const ceiling = {
      maxDevices: platform?.maxDevices ?? DEFAULT_ACCESS_POLICY.maxDevices,
      maxConcurrentSessions:
        platform?.maxConcurrentSessions ?? DEFAULT_ACCESS_POLICY.maxConcurrentSessions,
    };

    const academy = rows.find((row) => row.scope === 'academy');
    const plan = rows.find((row) => row.scope === 'plan');
    const chosen = academy ?? plan ?? platform;

    if (!chosen) {
      return { ...DEFAULT_ACCESS_POLICY, source: 'default' };
    }

    return {
      maxDevices: Math.min(chosen.maxDevices, ceiling.maxDevices),
      maxConcurrentSessions: Math.min(
        chosen.maxConcurrentSessions,
        ceiling.maxConcurrentSessions,
      ),
      source: chosen.scope,
    };
  }

  /** The ceiling an academy's own settings are validated against before they are written (D8). */
  async platformMaximums(tx: Prisma.TransactionClient): Promise<{
    readonly maxDevices: number;
    readonly maxConcurrentSessions: number;
  }> {
    const platform = await tx.accessPolicy.findFirst({ where: { scope: 'platform' } });
    return {
      maxDevices: platform?.maxDevices ?? DEFAULT_ACCESS_POLICY.maxDevices,
      maxConcurrentSessions:
        platform?.maxConcurrentSessions ?? DEFAULT_ACCESS_POLICY.maxConcurrentSessions,
    };
  }
}
