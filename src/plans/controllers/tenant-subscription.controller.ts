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
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { TenantSubscriptionService } from '../services/tenant-subscription.service';
import { TrialRedemptionService } from '../services/trial-redemption.service';
import type { CancellationReason } from '../services/trial-redemption.service';
import { CancelSubscriptionDto, StartTrialDto } from '../dto/subscription-lifecycle.dto';
import {
  resolveClientIp,
  resolveUserAgent,
} from '../../identity/utils/request-metadata.util';
import type { TenantSubscriptionResponse } from '../dto/tenant-subscription.contract';
import type { TenantAddOnResponse } from '../dto/tenant-add-on.contract';
import type { TenantUsageResponse } from '../dto/tenant-usage.contract';

/**
 * The billing authorization marker for every mutating route below.
 *
 * Owner-exclusive: `ORGANIZATION_OWNER_PERMISSIONS` grants it and
 * `ORGANIZATION_MANAGER_PERMISSIONS` deliberately does not, so a Manager,
 * Instructor or Student — all of whom can hold real organization
 * membership — never holds it.
 *
 * WHY A `.view` PERMISSION GATES A MUTATION. Permissions are PERSISTED on
 * each `organization_memberships` row at the time the membership is
 * created, not derived at request time. Introducing a new
 * `tenant.subscription.manage` string would therefore be absent from
 * every membership row that already exists, locking every current owner
 * out of their own billing until a backfill migration ran — a far worse
 * outcome than reusing the marker that already means "this person is the
 * organization's billing owner". The security property that matters here
 * is exclusivity, and this string has it.
 */
const BILLING_MANAGE_PERMISSION = 'tenant.subscription.view';

interface StartTrialResponse {
  readonly started: boolean;
  readonly reason?: string;
  readonly trialEndsAt?: string;
}

interface CancellationResponse {
  readonly cancelled: boolean;
  readonly alreadyCancelled: boolean;
  readonly effectiveAt: string;
}

@Controller('organizations')
@UseGuards(JwtAuthGuard, OrganizationMembershipGuard)
export class TenantSubscriptionController {
  constructor(
    private readonly tenantSubscriptionService: TenantSubscriptionService,
    private readonly trialRedemptionService: TrialRedemptionService,
  ) {}

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

  /**
   * Phase 10.2 — the ONE place a Free Trial is ever granted.
   *
   * AUTHORIZATION. `OrganizationMembershipGuard` proves only that the
   * caller belongs to the organization — which a Manager, Instructor or
   * Student of one of its academies also does. Billing is
   * owner/administrator territory, so the real check is the
   * owner-exclusive billing permission below, exactly the pattern
   * `DashboardController` uses for `tenant.dashboard.view`.
   * Hiding the button in the UI is not a control; this is.
   */
  @Post(':id/subscription/trial')
  @HttpCode(HttpStatus.OK)
  async startTrial(
    @Param('id') id: string,
    @Req() request: Request,
    @Body() dto: StartTrialDto,
  ): Promise<StartTrialResponse> {
    this.assertCanManageBilling(request);

    const result = await this.trialRedemptionService.startTrial(
      id,
      request.authContext!.userId,
      dto.planId,
      // Forensic only — recorded on the redemption, never part of the
      // eligibility decision.
      { ipAddress: resolveClientIp(request), userAgent: resolveUserAgent(request) },
    );

    return {
      started: result.started,
      reason: result.reason,
      trialEndsAt: result.trialEndsAt?.toISOString(),
    };
  }

  /**
   * Phase 10.2 — cancels an active Free Trial. Access ends immediately.
   *
   * Cancelling never restores trial eligibility — see
   * `TrialRedemptionService.cancelTrial`.
   */
  @Post(':id/subscription/trial/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelTrial(
    @Param('id') id: string,
    @Req() request: Request,
    @Body() dto: CancelSubscriptionDto,
  ): Promise<CancellationResponse> {
    this.assertCanManageBilling(request);

    const result = await this.trialRedemptionService.cancelTrial(
      id,
      request.authContext!.userId,
      { reason: dto.reason as CancellationReason, feedback: dto.feedback },
    );

    return {
      cancelled: result.cancelled || result.alreadyCancelled,
      alreadyCancelled: result.alreadyCancelled,
      effectiveAt: result.effectiveAt.toISOString(),
    };
  }

  /**
   * Phase 10.2 — cancels a paid subscription at the end of the period
   * already paid for. Time the customer has purchased is never forfeited.
   */
  @Post(':id/subscription/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelSubscription(
    @Param('id') id: string,
    @Req() request: Request,
    @Body() dto: CancelSubscriptionDto,
  ): Promise<CancellationResponse> {
    this.assertCanManageBilling(request);

    const result = await this.trialRedemptionService.cancelSubscription(
      id,
      request.authContext!.userId,
      { reason: dto.reason as CancellationReason, feedback: dto.feedback },
    );

    return {
      cancelled: result.cancelled || result.alreadyCancelled,
      alreadyCancelled: result.alreadyCancelled,
      effectiveAt: result.effectiveAt.toISOString(),
    };
  }

  /**
   * The real billing authorization boundary for every mutating route
   * above.
   *
   * `BILLING_MANAGE_PERMISSION` is owner-exclusive (see its own doc
   * comment above), so a Manager, Instructor or
   * Student — all of whom can hold organization membership — is refused
   * here even though the membership guard already passed.
   */
  private assertCanManageBilling(request: Request): void {
    const permissions = request.tenantContext?.permissions ?? [];
    if (!permissions.includes(BILLING_MANAGE_PERMISSION)) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }
  }
}
