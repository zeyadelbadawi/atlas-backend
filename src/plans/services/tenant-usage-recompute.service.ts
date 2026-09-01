/**
 * TenantUsageRecomputeService — the real recomputation logic behind the
 * `tenant-usage-recompute` worker (master plan §12). A genuine service,
 * independently unit/integration-testable, not just a processor callback
 * — the BullMQ processor (`TenantUsageRecomputeProcessor`) is a thin
 * wrapper that calls `recomputeOne`, mirroring `PasswordResetEmailProcessor`
 * delegating to a provider rather than embedding logic itself.
 *
 * `computeLiveCounts` (Phase 2 extraction) is the single source of truth
 * for "what is this organization's CURRENT usage of every plan-limited
 * resource, right now" — `recomputeOne` calls it and persists the result
 * (the cached `tenant_usage` row a dashboard read serves). The new
 * `EntitlementEnforcementService` calls the exact same method, inside the
 * SAME transaction as the write it is about to allow or reject, so a
 * server-side limit decision is never made against the cached snapshot
 * (which can be minutes stale) — see that service's own doc comment for
 * why "live count at write time" is a hard Phase 2 requirement, not an
 * optimization. One formula, two consumers — never two implementations of
 * "how many students does this organization have" that could silently
 * drift apart.
 *
 * Scope boundary (documented, not a silent gap): `computeLiveCounts`/
 * `recomputeOne` compute ONE organization's usage at a time, given its id
 * — they do NOT enumerate every organization on the platform themselves.
 * The periodic platform-wide safety-net sweep that calls `recomputeOne`
 * for every organization lives in `SubscriptionSweepService` (Phase 2),
 * which resolves the full organization list via the Platform Owner
 * cross-tenant bypass (`organizations_platform_select`, P15) — the
 * "explicit, role-scoped, and audited" bypass master plan §7 point 4
 * anticipated, which now exists (unlike when this doc comment was
 * originally written in P4, before P15 shipped).
 *
 * Idempotent by construction: every metric is fully recomputed from real
 * source tables and OVERWRITTEN (never incremented), matching master plan
 * §12's "Storage quota recomputation" row exactly ("Idempotent full
 * recompute, never incremental — avoids drift"). Running this twice in a
 * row with no data change produces byte-identical results.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import {
  TenantUsageRepository,
  TenantUsageCounts,
} from '../repositories/tenant-usage.repository';
import { bytesToGb } from '../utils/storage-units.util';

@Injectable()
export class TenantUsageRecomputeService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly tenantUsageRepository: TenantUsageRepository,
  ) {}

  /**
   * The real, live count for every `PlanLimitKey` — always computed fresh
   * from source tables inside the CALLER's own transaction/tenant context,
   * never cached, never approximated. Filtering conventions match this
   * codebase's established precedent exactly (see the per-field comments
   * below for which existing rule each one continues).
   */
  async computeLiveCounts(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<TenantUsageCounts> {
    const [
      academies,
      instructorRows,
      staffRows,
      courses,
      studentRows,
      generalStorage,
      videoStorage,
    ] = await Promise.all([
      // `academies` — non-archived only (an archived academy no longer
      // consumes the organization's quota).
      tx.academy.count({
        where: { organizationId, status: { not: 'archived' } },
      }),

      // `instructors`/`staff` — distinct users holding that specific
      // `academy_members.role`, active status, within non-archived
      // academies in this organization (this codebase's documented
      // interpretation — see the git history of this method for the full
      // reasoning: only the literally-matching role counts toward either
      // metric).
      tx.academyMember.findMany({
        where: {
          role: 'instructor',
          status: 'active',
          academy: { organizationId, status: { not: 'archived' } },
        },
        select: { userId: true },
        distinct: ['userId'],
      }),
      tx.academyMember.findMany({
        where: {
          role: 'staff',
          status: 'active',
          academy: { organizationId, status: { not: 'archived' } },
        },
        select: { userId: true },
        distinct: ['userId'],
      }),

      // `courses` — non-archived courses within non-archived academies in
      // this organization (authoring-capacity reading of the metric: how
      // many courses exist, not how many are published).
      tx.course.count({
        where: {
          status: { not: 'archived' },
          academy: { organizationId, status: { not: 'archived' } },
        },
      }),

      // `students` (Phase 2 — previously hardcoded `0`, `Enrollment` now
      // exists) — distinct students holding a real, currently-granted
      // Enrollment (any status except `unavailable`, the revoked/refunded
      // state — see `EnrollmentStatus`'s own doc comment) into a course of
      // a non-archived academy in this organization. `Enrollment.academyId`
      // is a plain denormalized column, not a Prisma relation (see that
      // model's own doc comment), so the academy/organization scope is
      // reached through the real `course` relation instead.
      tx.enrollment.findMany({
        where: {
          status: { not: 'unavailable' },
          course: { academy: { organizationId, status: { not: 'archived' } } },
        },
        select: { studentId: true },
        distinct: ['studentId'],
      }),

      // `generalStorageGb`/`videoStorageGb` (Phase 2 — previously
      // hardcoded `0`, `MediaAsset` now exists) — real byte totals from
      // `active` (non-archived) assets in non-archived academies, video
      // tracked separately from every other asset type, matching
      // `TenantUsage.videoStorageGb`'s own doc comment ("tracked
      // separately from general storage").
      tx.mediaAsset.aggregate({
        where: {
          status: 'active',
          type: { not: 'video' },
          academy: { organizationId, status: { not: 'archived' } },
        },
        _sum: { sizeBytes: true },
      }),
      tx.mediaAsset.aggregate({
        where: {
          status: 'active',
          type: 'video',
          academy: { organizationId, status: { not: 'archived' } },
        },
        _sum: { sizeBytes: true },
      }),
    ]);

    return {
      academies,
      instructors: instructorRows.length,
      staff: staffRows.length,
      courses,
      students: studentRows.length,
      generalStorageGb: bytesToGb(generalStorage._sum.sizeBytes),
      videoStorageGb: bytesToGb(videoStorage._sum.sizeBytes),
    };
  }

  async recomputeOne(organizationId: string): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const counts = await this.computeLiveCounts(tx, organizationId);
      await this.tenantUsageRepository.upsert(tx, organizationId, counts);
    });
  }
}
