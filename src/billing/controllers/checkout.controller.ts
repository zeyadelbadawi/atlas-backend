/**
 * CheckoutController — `organizations/:id/checkouts` (master plan §10 —
 * `CheckoutService`'s own `resource = 'organizations'` confirms the
 * nesting). Reuses `OrganizationMembershipGuard` verbatim, exactly like
 * `TenantSubscriptionController` (P4) — `:id` here IS the organization id
 * directly, no transitive resolution needed.
 */
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { CheckoutService } from '../services/checkout.service';
import { CreateCheckoutDto } from '../dto/create-checkout.dto';
import type { CheckoutResponse } from '../dto/checkout.contract';

@Controller('organizations')
@UseGuards(JwtAuthGuard, OrganizationMembershipGuard)
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post(':id/checkouts')
  async create(
    @Param('id') organizationId: string,
    @Body() payload: CreateCheckoutDto,
  ): Promise<CheckoutResponse> {
    return this.checkoutService.createCheckout(organizationId, payload);
  }

  @Get(':id/checkouts/:checkoutId')
  async get(
    @Param('id') organizationId: string,
    @Param('checkoutId') checkoutId: string,
  ): Promise<CheckoutResponse> {
    return this.checkoutService.getCheckout(organizationId, checkoutId);
  }
}
