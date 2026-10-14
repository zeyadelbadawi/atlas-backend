/**
 * OrganizationPaymentSettingsService — the Organization-level payment-
 * collection-mode setting (master plan §4.1/§5.8). Every method
 * re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantContext`, matching every other billing
 * service's own "never trust the guard's own read" discipline.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationPaymentSettingsRepository } from '../repositories/organization-payment-settings.repository';
import {
  toOrganizationPaymentSettingsResponse,
  type OrganizationPaymentSettingsResponse,
} from '../dto/organization-payment-settings.contract';
import type { UpdateOrganizationPaymentSettingsDto } from '../dto/update-organization-payment-settings.dto';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import type { PaymentCollectionMode } from '@prisma/client';

/** The modes an Organization may set for itself today (see `updatePaymentSettings`). */
const TENANT_SELECTABLE_MODES: readonly PaymentCollectionMode[] = ['unconfigured'];

@Injectable()
export class OrganizationPaymentSettingsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationPaymentSettingsRepository: OrganizationPaymentSettingsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
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

  /**
   * Task 3 — audited in the same transaction as the upsert, with the mode's
   * before/after ("no row" reads as `unconfigured`, matching the response).
   *
   * B0-COM-03 — an Organization can only clear its mode back to
   * `unconfigured`. `atlas_payments` (Atlas collects the learner's money on
   * its own accounts and takes a commission) and `organization_gateway` (no
   * adapter is registered) are not offered at launch, so a tenant must not
   * be able to switch learner payments onto them. Academy manual payment
   * methods do not depend on this mode and are unaffected.
   */
  async updatePaymentSettings(
    organizationId: string,
    payload: UpdateOrganizationPaymentSettingsDto,
    actorUserId: string,
  ): Promise<OrganizationPaymentSettingsResponse> {
    if (!TENANT_SELECTABLE_MODES.includes(payload.paymentCollectionMode)) {
      throw new ForbiddenException({
        messageKey: 'errors.payment.collectionModeNotAvailable',
      });
    }
    const settings = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const before =
          await this.organizationPaymentSettingsRepository.findByOrganizationId(
            tx,
            organizationId,
          );
        const saved = await this.organizationPaymentSettingsRepository.upsertMode(
          tx,
          organizationId,
          payload.paymentCollectionMode,
        );
        await this.auditLogWriterService.record(tx, {
          actorUserId,
          organizationId,
          action: 'organization.payment_settings.updated',
          targetId: organizationId,
          before: {
            paymentCollectionMode: before?.paymentCollectionMode ?? 'unconfigured',
          },
          after: { paymentCollectionMode: saved.paymentCollectionMode },
        });
        return saved;
      },
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
