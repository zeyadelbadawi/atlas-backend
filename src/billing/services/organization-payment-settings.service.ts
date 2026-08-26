/**
 * OrganizationPaymentSettingsService — the Organization-level payment-
 * collection-mode setting (master plan §4.1/§5.8). Every method
 * re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantContext`, matching every other billing
 * service's own "never trust the guard's own read" discipline.
 */
import { Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationPaymentSettingsRepository } from '../repositories/organization-payment-settings.repository';
import {
  toOrganizationPaymentSettingsResponse,
  type OrganizationPaymentSettingsResponse,
} from '../dto/organization-payment-settings.contract';
import type { UpdateOrganizationPaymentSettingsDto } from '../dto/update-organization-payment-settings.dto';

@Injectable()
export class OrganizationPaymentSettingsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationPaymentSettingsRepository: OrganizationPaymentSettingsRepository,
  ) {}

  async getPaymentSettings(
    organizationId: string,
  ): Promise<OrganizationPaymentSettingsResponse> {
    const settings = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.organizationPaymentSettingsRepository.findByOrganizationId(
          tx,
          organizationId,
        ),
    );
    return toOrganizationPaymentSettingsResponse(organizationId, settings);
  }

  async updatePaymentSettings(
    organizationId: string,
    payload: UpdateOrganizationPaymentSettingsDto,
  ): Promise<OrganizationPaymentSettingsResponse> {
    const settings = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.organizationPaymentSettingsRepository.upsertMode(
          tx,
          organizationId,
          payload.paymentCollectionMode,
        ),
    );
    return toOrganizationPaymentSettingsResponse(organizationId, settings);
  }

  /**
   * The real enforcement point for §4.1's "no silent default" rule — a
   * future P13 checkout call site calls this exact method and MUST treat
   * `false` as a hard block with an explicit configuration-required
   * response, never proceed with an assumed mode. Not called by anything
   * in this phase (no checkout exists yet) — provided now so P13 has one
   * real, tested seam to depend on instead of re-deriving this check.
   */
  async isConfigured(organizationId: string): Promise<boolean> {
    const settings = await this.getPaymentSettings(organizationId);
    return settings.paymentCollectionMode !== 'unconfigured';
  }
}
