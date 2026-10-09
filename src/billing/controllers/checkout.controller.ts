/**
 * CheckoutController — `organizations/:id/checkouts` (master plan §10 —
 * `CheckoutService`'s own `resource = 'organizations'` confirms the
 * nesting). Reuses `OrganizationMembershipGuard`, exactly like
 * `TenantSubscriptionController` (P4) — `:id` here IS the organization id
 * directly, no transitive resolution needed. Starting a checkout is
 * spending the organization's money and reading one exposes what it is
 * buying: owner-exclusive `tenant.payment.create` / `tenant.payment.view`
 * (`@OrganizationPermissions`), so an organization Manager or Instructor
 * gets 403.
 */
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { OrganizationPermissions } from '../../tenancy/decorators/organization-permissions.decorator';
import {
  TENANT_PAYMENT_CREATE_PERMISSION,
  TENANT_PAYMENT_VIEW_PERMISSION,
} from '../../tenancy/constants/organization-permissions.constants';
import { CheckoutService } from '../services/checkout.service';
import { CreateCheckoutDto } from '../dto/create-checkout.dto';
import type { CheckoutResponse } from '../dto/checkout.contract';
import { AllowInactiveSubscription } from '../../plans/decorators/allow-inactive-subscription.decorator';

/**
 * ALLOWED WHILE A SUBSCRIPTION IS INACTIVE.
 *
 * Checkout is how a lapsed tenant starts paying. Gating it on having
 * paid would be a closed loop.
 */
@AllowInactiveSubscription()
@Controller('organizations')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, OrganizationMembershipGuard)
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post(':id/checkouts')
  @OrganizationPermissions(TENANT_PAYMENT_CREATE_PERMISSION)
  async create(
    @Param('id') organizationId: string,
    @Body() payload: CreateCheckoutDto,
  ): Promise<CheckoutResponse> {
    return this.checkoutService.createCheckout(organizationId, payload);
  }

  @Get(':id/checkouts/:checkoutId')
  @OrganizationPermissions(TENANT_PAYMENT_VIEW_PERMISSION)
  async get(
    @Param('id') organizationId: string,
    @Param('checkoutId') checkoutId: string,
  ): Promise<CheckoutResponse> {
    return this.checkoutService.getCheckout(organizationId, checkoutId);
  }
}
