/**
 * TenantSubscriptionController — `organizations/:id/{subscription,usage,
 * add-ons}` (master plan §10 — `TenantService`'s `resource = 'organizations'`
 * confirms these nest under the existing Organizations resource, exactly
 * like `AcademiesController` nests `members`/`stats`/`activity` under one
 * academy).
 *
 * Reuses `OrganizationMembershipGuard` verbatim — unmodified, imported
 * from `TenancyModule` — rather than a new guard: `:id` here IS the
 * organization id directly (no transitive resolution needed, unlike
 * Academy's `:id`-is-an-academy-id problem), so the exact P2 guard that
 * already governs `GET /organizations/:id` governs these three routes
 * identically. A second, structurally distinct controller class can share
 * the same `@Controller('organizations')` base path as
 * `OrganizationsController` — Nest resolves routes by the full path+method
 * combination, not by which class declares the base path, and none of the
 * routes below collide with `OrganizationsController`'s own `GET :id`.
 */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { TenantSubscriptionService } from '../services/tenant-subscription.service';
import type { TenantSubscriptionResponse } from '../dto/tenant-subscription.contract';
import type { TenantAddOnResponse } from '../dto/tenant-add-on.contract';
import type { TenantUsageResponse } from '../dto/tenant-usage.contract';

@Controller('organizations')
@UseGuards(JwtAuthGuard, OrganizationMembershipGuard)
export class TenantSubscriptionController {
  constructor(private readonly tenantSubscriptionService: TenantSubscriptionService) {}

  @Get(':id/subscription')
  async getSubscription(@Param('id') id: string): Promise<TenantSubscriptionResponse> {
    return this.tenantSubscriptionService.getSubscription(id);
  }

  @Get(':id/usage')
  async getUsage(@Param('id') id: string): Promise<TenantUsageResponse> {
    return this.tenantSubscriptionService.getUsage(id);
  }

  @Get(':id/add-ons')
  async getActiveAddOns(@Param('id') id: string): Promise<TenantAddOnResponse[]> {
    return this.tenantSubscriptionService.getActiveAddOns(id);
  }
}
