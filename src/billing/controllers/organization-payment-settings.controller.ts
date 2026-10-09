/**
 * OrganizationPaymentSettingsController —
 * `organizations/:id/payment-settings*` (master plan §4.1/§5.8).
 *
 * ORGANIZATION OWNER ONLY. `OrganizationMembershipGuard` proves membership,
 * which a Manager or Instructor also holds; the class-level
 * `@OrganizationPermissions('tenant.billing.view')` narrows every route
 * here — reads included, since they expose gateway configuration and the
 * connected payout account — to the owner-exclusive billing permission
 * (`ORGANIZATION_OWNER_PERMISSIONS` carries it, the manager/instructor sets
 * deliberately do not). The frontend already gates the billing area on the
 * same string. A `.view` string gates the writes too for the reason
 * `TenantSubscriptionController` documents: permissions are persisted per
 * membership row, and a new `*.manage` string would lock out every
 * existing owner until a backfill ran.
 *
 * Commission is exposed here READ-ONLY (`GET .../commission`) — there is
 * no `PATCH` on this controller for it at all. Writing an Organization's
 * commission override is exclusively `PlatformCommissionController`
 * (Platform-Owner-gated) — the concrete enforcement of "an Organization
 * must not be able to grant itself a commission exemption or modify its
 * own rate" at the routing layer, on top of the RLS enforcement in
 * migration.sql.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { OrganizationPermissions } from '../../tenancy/decorators/organization-permissions.decorator';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { OrganizationPaymentSettingsService } from '../services/organization-payment-settings.service';
import { OrganizationGatewayCredentialsService } from '../services/organization-gateway-credentials.service';
import { OrganizationConnectedAccountService } from '../services/organization-connected-account.service';
import { CommissionService } from '../services/commission.service';
import { UpdateOrganizationPaymentSettingsDto } from '../dto/update-organization-payment-settings.dto';
import { SaveOrganizationGatewayCredentialDto } from '../dto/save-organization-gateway-credential.dto';
import type { OrganizationPaymentSettingsResponse } from '../dto/organization-payment-settings.contract';
import type {
  AvailablePaymentProviderResponse,
  OrganizationGatewayCredentialResponse,
} from '../dto/organization-gateway-credential.contract';
import type { OrganizationConnectedAccountResponse } from '../dto/organization-connected-account.contract';
import type { OrganizationCommissionResponse } from '../dto/commission.contract';
import { TENANT_BILLING_PERMISSION } from '../../tenancy/constants/organization-permissions.constants';

@Controller('organizations')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, OrganizationMembershipGuard)
@OrganizationPermissions(TENANT_BILLING_PERMISSION)
export class OrganizationPaymentSettingsController {
  constructor(
    private readonly organizationPaymentSettingsService: OrganizationPaymentSettingsService,
    private readonly organizationGatewayCredentialsService: OrganizationGatewayCredentialsService,
    private readonly organizationConnectedAccountService: OrganizationConnectedAccountService,
    private readonly commissionService: CommissionService,
  ) {}

  @Get(':id/payment-settings')
  async get(
    @Param('id') organizationId: string,
  ): Promise<OrganizationPaymentSettingsResponse> {
    return this.organizationPaymentSettingsService.getPaymentSettings(organizationId);
  }

  @Patch(':id/payment-settings')
  async update(
    @Param('id') organizationId: string,
    @Body() payload: UpdateOrganizationPaymentSettingsDto,
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<OrganizationPaymentSettingsResponse> {
    return this.organizationPaymentSettingsService.updatePaymentSettings(
      organizationId,
      payload,
      auth.userId,
    );
  }

  @Get(':id/payment-settings/gateway-providers')
  listAvailableGatewayProviders(): readonly AvailablePaymentProviderResponse[] {
    return this.organizationGatewayCredentialsService.listAvailableProviders();
  }

  @Get(':id/payment-settings/gateway-credentials')
  async getGatewayCredential(
    @Param('id') organizationId: string,
  ): Promise<OrganizationGatewayCredentialResponse> {
    return this.organizationGatewayCredentialsService.getCredential(organizationId);
  }

  @Put(':id/payment-settings/gateway-credentials')
  async saveGatewayCredential(
    @Param('id') organizationId: string,
    @Body() payload: SaveOrganizationGatewayCredentialDto,
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<OrganizationGatewayCredentialResponse> {
    return this.organizationGatewayCredentialsService.saveCredential(
      organizationId,
      payload,
      auth.userId,
    );
  }

  @Post(':id/payment-settings/gateway-credentials/test-connection')
  async testGatewayConnection(
    @Param('id') organizationId: string,
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<OrganizationGatewayCredentialResponse> {
    return this.organizationGatewayCredentialsService.testConnection(
      organizationId,
      auth.userId,
    );
  }

  @Post(':id/payment-settings/gateway-credentials/enable')
  async enableGateway(
    @Param('id') organizationId: string,
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<OrganizationGatewayCredentialResponse> {
    return this.organizationGatewayCredentialsService.setEnabled(
      organizationId,
      true,
      auth.userId,
    );
  }

  @Post(':id/payment-settings/gateway-credentials/disable')
  async disableGateway(
    @Param('id') organizationId: string,
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<OrganizationGatewayCredentialResponse> {
    return this.organizationGatewayCredentialsService.setEnabled(
      organizationId,
      false,
      auth.userId,
    );
  }

  @Get(':id/payment-settings/connected-account')
  async getConnectedAccount(
    @Param('id') organizationId: string,
  ): Promise<OrganizationConnectedAccountResponse> {
    return this.organizationConnectedAccountService.getConnectedAccount(organizationId);
  }

  /** Read-only visibility — see this controller's own doc comment for why there is no corresponding write route here. */
  @Get(':id/payment-settings/commission')
  async getCommission(
    @Param('id') organizationId: string,
  ): Promise<OrganizationCommissionResponse> {
    return this.commissionService.getOrganizationCommissionForOrganization(
      organizationId,
    );
  }
}
