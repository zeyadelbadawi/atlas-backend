/**
 * TenantUsageRecomputeService — the real recomputation logic behind the
 * `tenant-usage-recompute` worker (master plan §12). A genuine service,
 * independently unit/integration-testable, not just a processor callback
 * — the BullMQ processor (`TenantUsageRecomputeProcessor`) is a thin
 * wrapper that calls `recomputeOne`, mirroring `PasswordResetEmailProcessor`
 * delegating to a provider rather than embedding logic itself.
 *
 * Scope boundary (documented, not a silent gap): this service recomputes
 * ONE organization's usage at a time, given its id — it does NOT enumerate
 * every organization on the platform. A platform-wide scheduled sweep
 * would require reading `organizations` across every tenant, which the
 * `atlas_app` runtime role's RLS policies (`organizations_tenant_select`/
 * `organizations_member_select`) structurally cannot do — by design,
 * neither policy admits "every row, full stop." The only sanctioned way to
 * add that capability is master plan §7 point 4's "Platform Owner bypass
 * — explicit, role-scoped, and audited," which does not exist yet
 * (Phase P15, out of P4's scope; building it now would be inventing P15
 * inside P4). See `Reports/PROGRESS.md`'s P4 entry for the full reasoning
 * and `scripts/recompute-tenant-usage.ts` for the real, working per-
 * organization trigger this phase ships instead.
 *
 * Idempotent by construction: every metric is fully recomputed from real
 * source tables and OVERWRITTEN (never incremented), matching master plan
 * §12's "Storage quota recomputation" row exactly ("Idempotent full
 * recompute, never incremental — avoids drift"). Running this twice in a
 * row with no data change produces byte-identical results.
 */
import { Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { TenantUsageRepository } from '../repositories/tenant-usage.repository';

@Injectable()
export class TenantUsageRecomputeService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly tenantUsageRepository: TenantUsageRepository,
  ) {}

  async recomputeOne(organizationId: string): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      // `academies` — non-archived academies only (an archived academy no
      // longer consumes the organization's quota, matching the soft-
      // delete lifecycle convention used everywhere else in this schema).
      // Explicitly filters `organizationId` in addition to the RLS
      // context already scoping it — "application-layer scoping is still
      // mandatory, not redundant" (master plan §7 point 3).
      const academies = await tx.academy.count({
        where: { organizationId, status: { not: 'archived' } },
      });

      // `instructors`/`staff` — distinct users holding that specific
      // `academy_members.role` (see this codebase's documented
      // interpretation: only the literally-matching role counts toward
      // either metric — `owner`/`administrator`/`manager` are academy
      // leadership roles, not counted in ANY usage metric today, since no
      // `PlanLimitKey` exists for them; counted once per organization even
      // if the same user holds that role in multiple academies within it,
      // and only within non-archived academies with an `active`
      // membership status), across every academy in this organization.
      const [instructorRows, staffRows] = await Promise.all([
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
      ]);

      // `students`/`courses`/`generalStorageGb`/`videoStorageGb` — no
      // source table exists yet at this point in the project (enrollments/
      // students: Phase P6; courses: Phase P5; media/storage: Phase P8).
      // Honestly `0`, not fabricated, not left stale from a prior phase
      // that doesn't exist — matches master plan §12's explicit
      // instruction: "if courses do not exist because P5 has not been
      // implemented, do not fabricate course counts... document any
      // temporarily-zero/unavailable metric explicitly." This function is
      // structured so a later phase adds its own real COUNT here, in the
      // same place, once its table exists — nothing else in this service
      // needs to change.
      const students = 0;
      const courses = 0;
      const generalStorageGb = 0;
      const videoStorageGb = 0;

      await this.tenantUsageRepository.upsert(tx, organizationId, {
        academies,
        instructors: instructorRows.length,
        staff: staffRows.length,
        students,
        courses,
        generalStorageGb,
        videoStorageGb,
      });
    });
  }
}
