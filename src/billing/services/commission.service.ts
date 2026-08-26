/**
 * CommissionService — global default (Platform Owner), Organization
 * override (Platform-Owner-only write, Organization-readable), and
 * effective-rate resolution (master plan §4.2). Organization-facing reads
 * run under `runInTenantContext` (the tenant SELECT-only RLS policy);
 * Platform-Owner writes/reads run under `runInUserContext` (the
 * `is_platform_owner` RLS policy) — never the other way around, matching
 * the P12 migration's own documented "the two session variables are never
 * set together" tenant/platform separation for this exact reason.
 */
import { Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationCommissionSettingsRepository } from '../repositories/organization-commission-settings.repository';
import { AtlasCommissionConfigRepository } from '../repositories/atlas-commission-config.repository';
import { resolveEffectiveCommission } from '../utils/commission-resolution.util';
import {
  toAtlasCommissionConfigResponse,
  toOrganizationCommissionResponse,
  type AtlasCommissionConfigResponse,
  type OrganizationCommissionResponse,
} from '../dto/commission.contract';
import type { UpdateOrganizationCommissionDto } from '../dto/update-organization-commission.dto';

@Injectable()
export class CommissionService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationCommissionSettingsRepository: OrganizationCommissionSettingsRepository,
    private readonly atlasCommissionConfigRepository: AtlasCommissionConfigRepository,
  ) {}

  // --- Global default (Platform Owner) ---------------------------------

  async getGlobalConfig(): Promise<AtlasCommissionConfigResponse> {
    const config = await this.atlasCommissionConfigRepository.findSingleton();
    return toAtlasCommissionConfigResponse(config);
  }

  async setGlobalDefault(
    platformOwnerUserId: string,
    defaultCommissionBasisPoints: number,
  ): Promise<AtlasCommissionConfigResponse> {
    const config = await this.atlasCommissionConfigRepository.setDefault(
      defaultCommissionBasisPoints,
      platformOwnerUserId,
    );
    return toAtlasCommissionConfigResponse(config);
  }

  // --- Organization override (Platform-Owner write, Organization read) --

  /** Organization self-view — read-only by construction (no write method here takes a tenant-scoped caller). */
  async getOrganizationCommissionForOrganization(
    organizationId: string,
  ): Promise<OrganizationCommissionResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const settings =
        await this.organizationCommissionSettingsRepository.findByOrganizationId(
          tx,
          organizationId,
        );
      const global = await this.atlasCommissionConfigRepository.findSingleton();
      const effective = resolveEffectiveCommission(
        settings?.commissionMode,
        settings?.customPercentageBasisPoints,
        global.defaultCommissionBasisPoints,
      );
      return toOrganizationCommissionResponse(organizationId, settings, effective);
    });
  }

  async getOrganizationCommissionAsPlatformOwner(
    platformOwnerUserId: string,
    organizationId: string,
  ): Promise<OrganizationCommissionResponse> {
    return this.tenancyContextService.runInUserContext(
      platformOwnerUserId,
      async (tx) => {
        const settings =
          await this.organizationCommissionSettingsRepository.findByOrganizationId(
            tx,
            organizationId,
          );
        const global = await this.atlasCommissionConfigRepository.findSingleton();
        const effective = resolveEffectiveCommission(
          settings?.commissionMode,
          settings?.customPercentageBasisPoints,
          global.defaultCommissionBasisPoints,
        );
        return toOrganizationCommissionResponse(organizationId, settings, effective);
      },
    );
  }

  async setOrganizationCommission(
    platformOwnerUserId: string,
    organizationId: string,
    payload: UpdateOrganizationCommissionDto,
  ): Promise<OrganizationCommissionResponse> {
    return this.tenancyContextService.runInUserContext(
      platformOwnerUserId,
      async (tx) => {
        const settings = await this.organizationCommissionSettingsRepository.upsert(
          tx,
          organizationId,
          {
            commissionMode: payload.commissionMode,
            // Defensive, matching the DTO's own `ValidateIf` — a mode other
            // than `custom` never persists a stray percentage value.
            customPercentageBasisPoints:
              payload.commissionMode === 'custom'
                ? (payload.customPercentageBasisPoints ?? null)
                : null,
            updatedBy: platformOwnerUserId,
          },
        );
        const global = await this.atlasCommissionConfigRepository.findSingleton();
        const effective = resolveEffectiveCommission(
          settings.commissionMode,
          settings.customPercentageBasisPoints,
          global.defaultCommissionBasisPoints,
        );
        return toOrganizationCommissionResponse(organizationId, settings, effective);
      },
    );
  }
}
