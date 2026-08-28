/**
 * CommissionService — global default (Platform Owner), Plan-tier override
 * (Platform-Owner write, Phase P13 addition), Organization override
 * (Platform-Owner-only write, Organization-readable), and effective-rate
 * resolution across all three (§4.2, extended by this session's P13
 * product direction to a three-tier hierarchy). Organization-facing reads
 * run under `runInTenantContext` (the tenant SELECT-only RLS policy);
 * Platform-Owner writes/reads run under `runInUserContext` (the
 * `is_platform_owner` RLS policy) — never the other way around, matching
 * the P12 migration's own documented "the two session variables are never
 * set together" tenant/platform separation for this exact reason.
 *
 * `resolveEffectiveCommissionForOrganization` is the one new P13 entry
 * point Course Commerce actually calls at Payment-creation time (§4.2's
 * "resolved exactly once, at the moment a course-order Payment is
 * created, then frozen" snapshot rule) — it is deliberately just a
 * read-only composition of the same repositories/pure function every
 * other method here already uses, not a new resolution mechanism.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { PrismaService } from '../../database/prisma.service';
import { OrganizationCommissionSettingsRepository } from '../repositories/organization-commission-settings.repository';
import { AtlasCommissionConfigRepository } from '../repositories/atlas-commission-config.repository';
import { PlanCommissionSettingsRepository } from '../repositories/plan-commission-settings.repository';
import { TenantSubscriptionsRepository } from '../../plans/repositories/tenant-subscriptions.repository';
import { PlansRepository } from '../../plans/repositories/plans.repository';
import { resolveEffectiveCommission } from '../utils/commission-resolution.util';
import {
  toAtlasCommissionConfigResponse,
  toOrganizationCommissionResponse,
  type AtlasCommissionConfigResponse,
  type EffectiveCommissionResolution,
  type OrganizationCommissionResponse,
  type PlanCommissionResponse,
} from '../dto/commission.contract';
import type { UpdateOrganizationCommissionDto } from '../dto/update-organization-commission.dto';

@Injectable()
export class CommissionService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationCommissionSettingsRepository: OrganizationCommissionSettingsRepository,
    private readonly atlasCommissionConfigRepository: AtlasCommissionConfigRepository,
    private readonly planCommissionSettingsRepository: PlanCommissionSettingsRepository,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    private readonly plansRepository: PlansRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly prisma: PrismaService,
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

    // Phase P15 retroactive audit coverage. `setDefault` above is its own
    // atomic upsert (not part of a larger transaction this service
    // already opens) — a separate, best-effort write here is the
    // documented, lower-risk choice over restructuring this repository's
    // existing signature; see `AuditLogWriterService.writeBestEffort`'s
    // own doc comment.
    await this.prisma.$transaction((tx) =>
      this.auditLogWriterService.writeBestEffort(tx, {
        actorUserId: platformOwnerUserId,
        action: 'commission_config.global_default_updated',
        targetType: 'atlas_commission_config',
        targetId: config.id,
        context: { defaultCommissionBasisPoints },
      }),
    );

    return toAtlasCommissionConfigResponse(config);
  }

  // --- Plan-tier override (Platform Owner write, Phase P13) -------------

  async getPlanCommission(planKey: string): Promise<PlanCommissionResponse> {
    const plan = await this.plansRepository.findByKey(planKey);
    if (!plan) {
      return { planKey, commissionBasisPoints: null, updatedAt: null };
    }
    const settings = await this.planCommissionSettingsRepository.findByPlanId(plan.id);
    return {
      planKey,
      commissionBasisPoints: settings?.commissionBasisPoints ?? null,
      updatedAt: settings?.updatedAt.toISOString() ?? null,
    };
  }

  async setPlanCommission(
    platformOwnerUserId: string,
    planKey: string,
    commissionBasisPoints: number,
  ): Promise<PlanCommissionResponse> {
    const plan = await this.plansRepository.findByKey(planKey);
    if (!plan)
      throw new NotFoundException({ messageKey: 'errors.checkout.planNotFound' });

    const settings = await this.planCommissionSettingsRepository.upsert(
      plan.id,
      commissionBasisPoints,
      platformOwnerUserId,
    );
    return {
      planKey,
      commissionBasisPoints: settings.commissionBasisPoints,
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  /** Internal helper — resolves the Organization's currently-subscribed Plan's own commission override, or `null` if there is no active subscription or the Plan has none configured. Never throws; a missing subscription simply means "no plan tier to fall through to," matching this method's callers' own "skip this tier" handling. */
  private async findPlanCommissionForOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<number | null> {
    const subscription = await this.tenantSubscriptionsRepository.findByOrganizationId(
      tx,
      organizationId,
    );
    if (!subscription) return null;
    const settings = await this.planCommissionSettingsRepository.findByPlanId(
      subscription.planId,
    );
    return settings?.commissionBasisPoints ?? null;
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
      const planCommissionBasisPoints = await this.findPlanCommissionForOrganization(
        tx,
        organizationId,
      );
      const global = await this.atlasCommissionConfigRepository.findSingleton();
      const effective = resolveEffectiveCommission(
        settings?.commissionMode,
        settings?.customPercentageBasisPoints,
        planCommissionBasisPoints,
        global.defaultCommissionBasisPoints,
      );
      return toOrganizationCommissionResponse(
        organizationId,
        settings,
        planCommissionBasisPoints,
        effective,
      );
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
        const planCommissionBasisPoints = await this.findPlanCommissionForOrganization(
          tx,
          organizationId,
        );
        const global = await this.atlasCommissionConfigRepository.findSingleton();
        const effective = resolveEffectiveCommission(
          settings?.commissionMode,
          settings?.customPercentageBasisPoints,
          planCommissionBasisPoints,
          global.defaultCommissionBasisPoints,
        );
        return toOrganizationCommissionResponse(
          organizationId,
          settings,
          planCommissionBasisPoints,
          effective,
        );
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
        const planCommissionBasisPoints = await this.findPlanCommissionForOrganization(
          tx,
          organizationId,
        );
        const global = await this.atlasCommissionConfigRepository.findSingleton();
        const effective = resolveEffectiveCommission(
          settings.commissionMode,
          settings.customPercentageBasisPoints,
          planCommissionBasisPoints,
          global.defaultCommissionBasisPoints,
        );
        return toOrganizationCommissionResponse(
          organizationId,
          settings,
          planCommissionBasisPoints,
          effective,
        );
      },
    );
  }

  // --- Phase P13 entry point: snapshot-time resolution -------------------

  /**
   * The ONE place Course Commerce resolves "what commission rate applies
   * to this Organization right now" — called exactly once, at Payment
   * creation, by `CourseOrderPaymentsService`, whose caller freezes the
   * result onto `payments.commission_rate_basis_points_snapshot`/
   * `.commission_amount_minor_units` and never recomputes it (§4.2). Takes
   * an already-open transaction so it composes into the caller's own
   * atomic Payment-creation transaction rather than opening a second one.
   */
  async resolveEffectiveCommissionForOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<EffectiveCommissionResolution> {
    const settings =
      await this.organizationCommissionSettingsRepository.findByOrganizationId(
        tx,
        organizationId,
      );
    const planCommissionBasisPoints = await this.findPlanCommissionForOrganization(
      tx,
      organizationId,
    );
    const global = await this.atlasCommissionConfigRepository.findSingleton();
    return resolveEffectiveCommission(
      settings?.commissionMode,
      settings?.customPercentageBasisPoints,
      planCommissionBasisPoints,
      global.defaultCommissionBasisPoints,
    );
  }
}
