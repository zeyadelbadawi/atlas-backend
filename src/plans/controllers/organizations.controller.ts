/**
 * OrganizationsController — `POST /organizations` (Phase P19, relocated
 * here in Phase 2). Deliberately a SEPARATE controller from
 * `PlatformModule`'s `organizations.controller.ts` (the flat, read-only,
 * Platform-Owner-only cross-tenant view) — same base path, disjoint
 * routes, exactly like `CheckoutController`/`PaymentController`/
 * `ProvisioningRequestsController` already coexist under
 * `@Controller('organizations')` in their own modules. No
 * `OrganizationMembershipGuard` here: there is no `:id` yet — the caller
 * doesn't have a membership to verify until this endpoint creates one.
 *
 * Moved from `TenancyModule` into `PlansModule` in Phase 2 for the exact
 * same reason `PlatformModule`'s sibling controller moved out of
 * `TenancyModule` in Phase P15 (see that module's own doc comment): this
 * handler now needs `OrganizationSubscriptionBootstrapService` (the
 * roadmap's Decision 6 requirement — "a brand-new Organization
 * automatically receives a 3-day trial") alongside
 * `OrganizationsService`, and `TenancyModule` cannot import `PlansModule`
 * without creating this codebase's first module cycle (`PlansModule`
 * already depends on `TenancyModule`). `PlansModule` already depends on
 * `TenancyModule` one-directionally, so it can safely hold both.
 * `OrganizationsService.create` itself is untouched business logic,
 * reused verbatim — only its call site moved, via the new optional
 * `onCreated` transaction hook that service now accepts (see its own doc
 * comment), which is how the trial subscription gets created atomically
 * with the Organization and its owner membership, in one transaction,
 * without `OrganizationsService` ever importing anything from
 * `PlansModule`.
 */
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationsService } from '../../tenancy/services/organizations.service';
import { OrganizationSubscriptionBootstrapService } from '../services/organization-subscription-bootstrap.service';
import { TenantUsageRecomputeProducer } from '../queue/tenant-usage-recompute.producer';
import { CreateOrganizationDto } from '../../tenancy/dto/create-organization.dto';
import type { OrganizationResponse } from '../../tenancy/dto/organization.contract';

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly subscriptionBootstrapService: OrganizationSubscriptionBootstrapService,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
  ) {}

  @Post()
  async create(
    @Req() request: Request,
    @Body() payload: CreateOrganizationDto,
  ): Promise<OrganizationResponse> {
    // `request.authContext` is guaranteed set — `JwtAuthGuard` runs first.
    const organization = await this.organizationsService.create(
      request.authContext!.userId,
      payload,
      (tx, created) =>
        this.subscriptionBootstrapService.bootstrapTrialSubscription(tx, created.id),
    );

    // A real (all-zero) `tenant_usage` row from the very first moment,
    // rather than making a fresh Organization's Usage page wait for the
    // periodic safety-net sweep or its first Academy — cheap (an enqueue,
    // not the recompute itself) and directly serves the roadmap's own
    // "Usage page shows live, current numbers ... without a manual ops
    // script" criterion for the earliest possible moment it applies.
    await this.tenantUsageRecomputeProducer.enqueueOne(organization.id);

    return organization;
  }
}
