/**
 * Add-on install / enable / disable / uninstall — the tenant-facing
 * lifecycle, organization-scoped.
 *
 * WHY THIS IS ORGANIZATION-SCOPED, NOT ACADEMY-SCOPED. An add-on is bought
 * and entitled at the ORGANIZATION level, exactly like the subscription it
 * hangs off — `tenant_add_ons` has always been keyed by organization. The
 * per-academy part of Live Sessions is the provider CONNECTION, which is a
 * separate resource for exactly that reason.
 *
 * AUTHORIZATION. Installing an add-on is a commercial act, so it requires
 * the same owner-exclusive billing permission the subscription routes use
 * — a Manager or Instructor can run sessions but cannot buy the add-on
 * that enables them. `@AllowInactiveSubscription` is NOT applied: unlike
 * paying, installing an add-on is not something a lapsed tenant should be
 * able to do, and `AddOnAccessService` reports `subscription_inactive`
 * rather than letting them.
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { IsBoolean, Equals } from 'class-validator';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AddOnsRepository } from '../../plans/repositories/add-ons.repository';
import { TenantAddOnsRepository } from '../../plans/repositories/tenant-add-ons.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { AddOnAccessService } from '../services/add-on-access.service';

/** Owner-exclusive, matching `TenantSubscriptionController`'s own gate. */
const BILLING_MANAGE_PERMISSION = 'tenant.subscription.view';

/**
 * Explicit confirmation, for the same reason the trial and cancellation
 * routes require it: a stray retry or a mis-wired button must not install
 * or uninstall a paid capability.
 */
export class AddOnLifecycleDto {
  @IsBoolean()
  @Equals(true, { message: 'validation:confirmationRequired' })
  confirm!: boolean;
}

@Controller('organizations')
@UseGuards(JwtAuthGuard, OrganizationMembershipGuard)
export class AddOnsLifecycleController {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly addOnsRepository: AddOnsRepository,
    private readonly tenantAddOnsRepository: TenantAddOnsRepository,
    private readonly addOnAccessService: AddOnAccessService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  /**
   * The catalog, annotated with THIS tenant's state for each entry.
   *
   * Readable by any organization member: seeing that an add-on exists is
   * not a billing action, and hiding the catalog from the people who would
   * ask for it is how a product fails to sell anything.
   */
  @Get(':id/add-ons/catalog')
  async catalog(@Param('id') organizationId: string) {
    const catalog = await this.addOnsRepository.findAll();

    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const installed = await this.tenantAddOnsRepository.findAllForOrganization(
        tx,
        organizationId,
      );
      const byAddOnId = new Map(installed.map((row) => [row.addOnId, row]));

      return catalog.map((addOn) => {
        const install = byAddOnId.get(addOn.id);
        return {
          id: addOn.id,
          key: addOn.key,
          name: addOn.name,
          description: addOn.description ?? undefined,
          effect: addOn.effect,
          compatiblePlanKeys: addOn.compatiblePlanKeys,
          pricing: addOn.pricing ?? undefined,
          // `free` is simply "no price attached" — the same catalog
          // decides it, so no separate flag can drift out of step.
          isFree: !addOn.pricing,
          installStatus: install?.status ?? 'uninstalled',
          failureReason: install?.failureReason ?? undefined,
        };
      });
    });
  }

  @Post(':id/add-ons/:addOnKey/install')
  @HttpCode(HttpStatus.OK)
  async install(
    @Param('id') organizationId: string,
    @Param('addOnKey') addOnKey: string,
    @Req() request: Request,
    @Body() _dto: AddOnLifecycleDto,
  ) {
    return this.transition(organizationId, addOnKey, request, 'install');
  }

  @Post(':id/add-ons/:addOnKey/enable')
  @HttpCode(HttpStatus.OK)
  async enable(
    @Param('id') organizationId: string,
    @Param('addOnKey') addOnKey: string,
    @Req() request: Request,
    @Body() _dto: AddOnLifecycleDto,
  ) {
    return this.transition(organizationId, addOnKey, request, 'enable');
  }

  @Post(':id/add-ons/:addOnKey/disable')
  @HttpCode(HttpStatus.OK)
  async disable(
    @Param('id') organizationId: string,
    @Param('addOnKey') addOnKey: string,
    @Req() request: Request,
    @Body() _dto: AddOnLifecycleDto,
  ) {
    return this.transition(organizationId, addOnKey, request, 'disable');
  }

  /**
   * Uninstall.
   *
   * DELIBERATELY NON-DESTRUCTIVE. Nothing belonging to the add-on is
   * deleted: sessions, attendance and recordings all survive, because a
   * customer who uninstalls and reinstalls next term must find their
   * history intact — and because destroying a term's attendance records on
   * a single click is not a recoverable mistake. What uninstalling does is
   * withdraw the entitlement, which stops new sessions being created.
   */
  @Post(':id/add-ons/:addOnKey/uninstall')
  @HttpCode(HttpStatus.OK)
  async uninstall(
    @Param('id') organizationId: string,
    @Param('addOnKey') addOnKey: string,
    @Req() request: Request,
    @Body() _dto: AddOnLifecycleDto,
  ) {
    return this.transition(organizationId, addOnKey, request, 'uninstall');
  }

  private async transition(
    organizationId: string,
    addOnKey: string,
    request: Request,
    action: 'install' | 'enable' | 'disable' | 'uninstall',
  ) {
    this.assertCanManageBilling(request);
    const actorUserId = request.authContext!.userId;

    const addOn = await this.addOnsRepository.findByKey(addOnKey);
    if (!addOn) throw new NotFoundException({ messageKey: 'errors.notFound' });

    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actorUserId,
      async (tx) => {
        if (action === 'install') {
          // `activate` is the existing repository method P12 already used
          // for a purchased add-on — reused rather than duplicated, so
          // there is one place a tenant add-on comes into existence.
          await this.tenantAddOnsRepository.activate(tx, organizationId, addOn.id);
        } else {
          const nextStatus =
            action === 'enable'
              ? 'enabled'
              : action === 'disable'
                ? 'disabled'
                : 'uninstalled';

          const existing = await this.tenantAddOnsRepository.findOne(
            tx,
            organizationId,
            addOn.id,
          );
          if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

          await this.tenantAddOnsRepository.setStatus(
            tx,
            organizationId,
            addOn.id,
            nextStatus,
          );
        }

        await this.auditLogWriterService.write(tx, {
          actorUserId,
          organizationId,
          action: `add_on.${action}`,
          targetType: 'tenant_add_on',
          targetId: addOn.id,
          context: { addOnKey },
        });

        // Report the resulting state rather than a bare 200, so the UI
        // renders the truth instead of assuming the transition's intent.
        return this.addOnAccessService.describe(
          tx,
          organizationId,
          addOnKey,
          // The feature this add-on grants, read from its own effect —
          // never a hardcoded capability name.
          (addOn.effect as { featureKey?: string }).featureKey as never,
        );
      },
    );
  }

  private assertCanManageBilling(request: Request): void {
    const permissions = request.tenantContext?.permissions ?? [];
    if (!permissions.includes(BILLING_MANAGE_PERMISSION)) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }
  }
}
