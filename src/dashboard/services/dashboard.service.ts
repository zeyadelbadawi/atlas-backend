/**
 * DashboardService — assembles `GET organizations/:id/dashboard` /
 * `GET academies/:id/dashboard` (Phase 8).
 *
 * Scoping is decided HERE, server-side, from which guard ran — never from
 * a client-supplied query parameter, and never by returning a superset
 * the frontend then filters. An Academy Manager's request reaches
 * `getForAcademy` with an `academyId` `AcademyScopeGuard` already proved
 * belongs to this Organization; an Organization Owner's reaches
 * `getForOrganization` with no academy narrowing at all. Both re-establish
 * the RLS tenant context independently of whatever the guard read
 * (`OrganizationsService.getById`'s own "never trust the guard's read"
 * discipline), so RLS remains a genuinely independent second layer.
 *
 * Every figure is real: counts come from live `COUNT(*)`s, revenue from
 * the real `revenue_ledger_entries` sums (see
 * `dashboard-overview.contract.ts`'s header comment for the honesty
 * boundary this phase's instructions required most explicitly), usage
 * from the existing `TenantSubscriptionService.getUsage` verbatim, and
 * activity from real `audit_log_entries` rows. Nothing here is
 * hardcoded, sampled, estimated, or placeholder.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { OrganizationPaymentSettingsRepository } from '../../billing/repositories/organization-payment-settings.repository';
import { TenantSubscriptionService } from '../../plans/services/tenant-subscription.service';
import {
  DashboardMetricsRepository,
  type DashboardScopeFilter,
} from '../repositories/dashboard-metrics.repository';
import type { TenantUsageResponse } from '../../plans/dto/tenant-usage.contract';
import type {
  DashboardActivityItemResponse,
  DashboardOverviewResponse,
  DashboardRevenueResponse,
  DashboardScopeResponse,
} from '../dto/dashboard-overview.contract';

const RECENT_ACTIVITY_LIMIT = 10;

@Injectable()
export class DashboardService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly dashboardMetricsRepository: DashboardMetricsRepository,
    private readonly academiesRepository: AcademiesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly organizationPaymentSettingsRepository: OrganizationPaymentSettingsRepository,
    private readonly tenantSubscriptionService: TenantSubscriptionService,
  ) {}

  /** The Client/Organization Owner's dashboard — every Academy under the Organization. */
  getForOrganization(organizationId: string): Promise<DashboardOverviewResponse> {
    return this.build({ organizationId });
  }

  /**
   * The Academy Manager's dashboard — exactly one Academy. `academyId`
   * always arrives from `AcademyScopeGuard`, which has already proved it
   * belongs to `organizationId`; this method never accepts one from a
   * request body or query string.
   *
   * `AcademyScopeGuard` is deliberately not sufficient on its own here.
   * Its own doc comment is explicit that Academy READ access is governed
   * by ORGANIZATION membership — which is right for the endpoints it was
   * built for, but would let a Manager of Academy A read Academy B's
   * dashboard, since both sit under the same organization. Decision 2
   * forbids exactly that ("A Manager assigned to Academy A ... must never
   * see, access, or manage Academy B or Academy C ... enforced at the
   * backend/API/database authorization level"). So this method
   * additionally requires the caller to be either a real member of THIS
   * academy (`academy_members`) or the organization's own owner — the
   * same two-tier rule `AcademiesService.assertCanManage` already applies
   * to Academy writes, applied here to this aggregate read. The shared
   * guard is left untouched, so no other phase's endpoints change
   * behavior.
   */
  async getForAcademy(
    organizationId: string,
    academyId: string,
    userId: string,
    isOrganizationOwner: boolean,
  ): Promise<DashboardOverviewResponse> {
    if (!isOrganizationOwner) {
      const membership = await this.tenancyContextService.runInTenantContext(
        organizationId,
        (tx) => this.academyMembersRepository.findForUserInAcademy(tx, academyId, userId),
      );
      if (!membership) {
        throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
      }
    }

    return this.build({ organizationId, academyId });
  }

  private async build(scope: DashboardScopeFilter): Promise<DashboardOverviewResponse> {
    const { counts, revenueTotals, paymentSettings, activity, academy } =
      await this.tenancyContextService.runInTenantContext(
        scope.organizationId,
        async (tx) => {
          const [
            academies,
            courses,
            publishedCourses,
            students,
            instructors,
            revenueRows,
            settings,
            activityRows,
            academyRow,
          ] = await Promise.all([
            this.dashboardMetricsRepository.countAcademies(tx, scope.organizationId),
            this.dashboardMetricsRepository.countCourses(tx, scope),
            this.dashboardMetricsRepository.countPublishedCourses(tx, scope),
            this.dashboardMetricsRepository.countStudents(tx, scope),
            this.dashboardMetricsRepository.countInstructors(tx, scope),
            this.dashboardMetricsRepository.sumRevenueByCurrency(tx, scope),
            this.organizationPaymentSettingsRepository.findByOrganizationId(
              tx,
              scope.organizationId,
            ),
            this.dashboardMetricsRepository.findRecentActivity(
              tx,
              scope,
              RECENT_ACTIVITY_LIMIT,
            ),
            scope.academyId
              ? this.academiesRepository.findById(tx, scope.academyId)
              : Promise.resolve(null),
          ]);

          return {
            counts: {
              // An Academy-scoped dashboard reports itself, never the
              // Organization's total — see the contract's own doc comment.
              academies: scope.academyId ? 1 : academies,
              courses,
              publishedCourses,
              students,
              instructors,
            },
            revenueTotals: revenueRows,
            paymentSettings: settings,
            activity: activityRows,
            academy: academyRow,
          };
        },
      );

    if (scope.academyId && !academy) {
      // Structurally unreachable — `AcademyScopeGuard` already read this
      // exact row moments ago — kept as a real check, never an assertion
      // (this codebase's established rule).
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    return {
      scope: this.toScopeResponse(scope, academy?.name),
      counts,
      revenue: this.toRevenueResponse(
        paymentSettings?.paymentCollectionMode,
        revenueTotals,
      ),
      usage: await this.loadUsage(scope.organizationId),
      recentActivity: activity.map(toActivityItemResponse),
    };
  }

  private toScopeResponse(
    scope: DashboardScopeFilter,
    academyName: string | undefined,
  ): DashboardScopeResponse {
    return scope.academyId
      ? {
          type: 'academy',
          organizationId: scope.organizationId,
          academyId: scope.academyId,
          academyName,
        }
      : { type: 'organization', organizationId: scope.organizationId };
  }

  /**
   * See `dashboard-overview.contract.ts`'s header comment. A missing
   * `organization_payment_settings` row means `unconfigured` — the same
   * "no row IS the default" mapping `OrganizationPaymentSettingsService`
   * already owns (§4.1), reused rather than reinterpreted here.
   */
  private toRevenueResponse(
    mode:
      | Prisma.OrganizationPaymentSettingsGetPayload<object>['paymentCollectionMode']
      | undefined,
    totals: readonly { currency: string; amountMinorUnits: bigint }[],
  ): DashboardRevenueResponse {
    const paymentCollectionMode = mode ?? 'unconfigured';
    const tracked = paymentCollectionMode === 'atlas_payments';

    return {
      tracked,
      paymentCollectionMode,
      // Deliberately emptied rather than reported when Atlas is not the
      // party to these transactions — never a fabricated or misleading
      // figure. (In practice the ledger is already empty in that mode; this
      // is the explicit guarantee, not a reliance on that happening to hold.)
      totals: tracked
        ? totals.map((total) => ({
            currency: total.currency,
            amountMinorUnits: Number(total.amountMinorUnits),
          }))
        : [],
    };
  }

  /**
   * Reuses `TenantSubscriptionService.getUsage` verbatim — the ONE place
   * effective entitlements are computed (that service's own rule). Its
   * two honest-empty-state 404s (no subscription / usage never
   * recomputed) are translated to `null` here rather than propagated:
   * a dashboard missing its usage widget is a real, expected state for a
   * brand-new organization, not a failed dashboard request.
   */
  private async loadUsage(organizationId: string): Promise<TenantUsageResponse | null> {
    try {
      return await this.tenantSubscriptionService.getUsage(organizationId);
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }
}

function toActivityItemResponse(row: {
  id: string;
  action: string;
  targetType: string;
  targetLabel: string | null;
  academyId: string | null;
  role: string | null;
  occurredAt: Date;
  actor: { name: string };
}): DashboardActivityItemResponse {
  return {
    id: row.id,
    action: row.action,
    targetType: row.targetType,
    targetLabel: row.targetLabel ?? undefined,
    actorName: row.actor.name,
    actorRole: row.role ?? undefined,
    academyId: row.academyId ?? undefined,
    occurredAt: row.occurredAt.toISOString(),
  };
}
