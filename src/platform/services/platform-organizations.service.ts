/**
 * PlatformOrganizationsService — the Platform Owner's cross-tenant
 * `GET /organizations`/`GET /organizations/:id` read surface (master plan
 * §21 Phase P15). Every read runs under
 * `TenancyContextService.runInUserContext(platformOwnerId)`, relying on
 * the additive `_platform_select` RLS policies the P15 migration adds to
 * `organizations`/`organization_memberships`/`academies` — never a
 * second, ungated query path. `subscription`/`usage` are assembled by
 * delegating to `TenantSubscriptionService.getSubscription`/`.getUsage`
 * (P4) for the now-resolved `organizationId` — the exact "Platform Owner
 * resolves the target, then delegates into the SAME tenant-scoped logic"
 * pattern `PlatformCourseOrderPaymentsService.approvePayment` (P13) and
 * `PlatformProvisioningService` (P14) already established, reusing the
 * full entitlement-aware assembly verbatim rather than re-deriving it.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationsRepository } from '../../tenancy/repositories/organizations.repository';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { TenantSubscriptionService } from '../../plans/services/tenant-subscription.service';
import { TenantSubscriptionsRepository } from '../../plans/repositories/tenant-subscriptions.repository';
import { toTenantSubscriptionResponse } from '../../plans/dto/tenant-subscription.contract';
import {
  toPlatformOrganizationDetailResponse,
  toPlatformOrganizationSummaryResponse,
} from '../dto/platform-organization.contract';
import type {
  PlatformOrganizationDetailResponse,
  PlatformOrganizationSummaryResponse,
} from '../dto/platform-organization.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { TenantSubscriptionResponse } from '../../plans/dto/tenant-subscription.contract';
import type { TenantUsageResponse } from '../../plans/dto/tenant-usage.contract';

@Injectable()
export class PlatformOrganizationsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationsRepository: OrganizationsRepository,
    private readonly organizationMembershipsRepository: OrganizationMembershipsRepository,
    private readonly academiesRepository: AcademiesRepository,
    private readonly tenantSubscriptionService: TenantSubscriptionService,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
  ) {}

  async listOrganizations(
    platformOwnerId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<PlatformOrganizationSummaryResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        this.organizationsRepository.findManyAnyOrganization(tx, {
          search: query.search,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    // One batched query for the whole page's `planName`/`subscriptionStatus`
    // columns — master plan §27's N+1-avoidance — rather than one
    // `getSubscription` call per row.
    const subscriptions = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        this.tenantSubscriptionsRepository.findManyByOrganizationIds(
          tx,
          items.map((organization) => organization.id),
        ),
    );
    const subscriptionsByOrgId = new Map(
      subscriptions.map((subscription) => [
        subscription.organizationId,
        toTenantSubscriptionResponse(subscription),
      ]),
    );

    const responses = items.map((organization) =>
      toPlatformOrganizationSummaryResponse(
        organization,
        subscriptionsByOrgId.get(organization.id),
      ),
    );

    return {
      items: responses,
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getOrganization(
    platformOwnerId: string,
    organizationId: string,
  ): Promise<PlatformOrganizationDetailResponse> {
    const organization = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) => this.organizationsRepository.findByIdAnyOrganization(tx, organizationId),
    );
    if (!organization) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    const [subscription, usage, academies, members] = await Promise.all([
      this.tryGetSubscription(organizationId),
      this.tryGetUsage(organizationId),
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.academiesRepository.findRefsForOrganization(tx, organizationId),
      ),
      this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.organizationMembershipsRepository.findManyForOrganization(
          tx,
          organizationId,
        ),
      ),
    ]);

    return toPlatformOrganizationDetailResponse(
      organization,
      subscription,
      usage,
      academies,
      members,
    );
  }

  /** `TenantSubscriptionService.getSubscription` throws `NotFoundException` when no subscription row exists yet (a real, honest state — see its own doc comment) — `subscription`/`planName`/`subscriptionStatus` are all optional on the Platform contract precisely for this case, never a fabricated default. */
  private async tryGetSubscription(
    organizationId: string,
  ): Promise<TenantSubscriptionResponse | undefined> {
    try {
      return await this.tenantSubscriptionService.getSubscription(organizationId);
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
  }

  private async tryGetUsage(
    organizationId: string,
  ): Promise<TenantUsageResponse | undefined> {
    try {
      return await this.tenantSubscriptionService.getUsage(organizationId);
    } catch (error) {
      if (error instanceof NotFoundException) return undefined;
      throw error;
    }
  }
}
