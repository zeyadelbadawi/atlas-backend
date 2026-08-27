/**
 * PlatformCommissionController — `/platform-commission/*` (master plan
 * §4.2). Flat, cross-tenant, `PlatformOwnerGuard`-gated — mirrors
 * `PlatformPaymentController`/`PlatformDomainController`'s identical
 * shape. The ONLY place in this codebase that can write
 * `atlas_commission_config`/`organization_commission_settings` — an
 * Organization has no route anywhere that reaches either write method
 * (§4.2's "an Organization must not be able to grant itself a commission
 * exemption or modify its own rate," enforced here at the routing layer
 * on top of RLS).
 */
import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { CommissionService } from '../services/commission.service';
import { UpdateAtlasCommissionConfigDto } from '../dto/update-atlas-commission-config.dto';
import { UpdateOrganizationCommissionDto } from '../dto/update-organization-commission.dto';
import { UpdatePlanCommissionDto } from '../dto/update-plan-commission.dto';
import type {
  AtlasCommissionConfigResponse,
  OrganizationCommissionResponse,
  PlanCommissionResponse,
} from '../dto/commission.contract';

@Controller('platform-commission')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class PlatformCommissionController {
  constructor(private readonly commissionService: CommissionService) {}

  @Get('global')
  async getGlobal(): Promise<AtlasCommissionConfigResponse> {
    return this.commissionService.getGlobalConfig();
  }

  @Patch('global')
  async updateGlobal(
    @CurrentAuthContext() auth: AuthContext,
    @Body() payload: UpdateAtlasCommissionConfigDto,
  ): Promise<AtlasCommissionConfigResponse> {
    return this.commissionService.setGlobalDefault(
      auth.userId,
      payload.defaultCommissionBasisPoints,
    );
  }

  /** Phase P13 — the plan-tier level of §4.2's three-tier hierarchy. `:planKey` (not a Plan id) matches every other Plan-scoped route in this codebase (`PlansController`'s own `key`-addressed shape). */
  @Get('plans/:planKey')
  async getForPlan(@Param('planKey') planKey: string): Promise<PlanCommissionResponse> {
    return this.commissionService.getPlanCommission(planKey);
  }

  @Patch('plans/:planKey')
  async updateForPlan(
    @CurrentAuthContext() auth: AuthContext,
    @Param('planKey') planKey: string,
    @Body() payload: UpdatePlanCommissionDto,
  ): Promise<PlanCommissionResponse> {
    return this.commissionService.setPlanCommission(
      auth.userId,
      planKey,
      payload.commissionBasisPoints,
    );
  }

  @Get('organizations/:organizationId')
  async getForOrganization(
    @CurrentAuthContext() auth: AuthContext,
    @Param('organizationId') organizationId: string,
  ): Promise<OrganizationCommissionResponse> {
    return this.commissionService.getOrganizationCommissionAsPlatformOwner(
      auth.userId,
      organizationId,
    );
  }

  @Patch('organizations/:organizationId')
  async updateForOrganization(
    @CurrentAuthContext() auth: AuthContext,
    @Param('organizationId') organizationId: string,
    @Body() payload: UpdateOrganizationCommissionDto,
  ): Promise<OrganizationCommissionResponse> {
    return this.commissionService.setOrganizationCommission(
      auth.userId,
      organizationId,
      payload,
    );
  }
}
