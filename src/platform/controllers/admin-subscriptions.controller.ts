/**
 * AdminSubscriptionsController — `GET /platform-subscriptions/overview`.
 *
 * ONE HYPHENATED SEGMENT, NOT `platform/subscriptions`. The resource was
 * originally mounted with a slash, which made the page permanently
 * unreachable: `resourcePath()` (frontend `services/api/request.utils.ts`)
 * runs `encodeURIComponent` over every segment it is given, so a resource
 * containing `/` became `platform%2Fsubscriptions` and every request 404'd.
 * This was the only service of 49 whose resource carried a slash. Every
 * sibling Platform-Owner surface already uses a single hyphenated segment
 * (`platform-add-ons`, `platform-zoom`, `platform-academies`,
 * `platform-users`, `platform-metrics`), so this now matches them rather
 * than depending on the path builder tolerating a separator.
 *
 * AUTHORIZATION IS THE POINT OF THIS FILE. `PlatformOwnerGuard` checks
 * the acting user's real `is_platform_owner` column, re-read from the
 * database on every request rather than trusted from a token claim (see
 * the guard's own doc comment). An Organization Owner, Manager,
 * Instructor or Student is refused here regardless of any organization
 * membership or permission they hold, because platform ownership is a
 * property of the user, not of a tenant relationship.
 *
 * Hiding the sidebar entry in the frontend is NOT what protects this
 * data. This guard is. The navigation change is a usability affordance
 * on top of it, and the security tests assert this endpoint directly with
 * non-admin tokens rather than asserting anything about the UI.
 *
 * Mounted in `PlatformModule` alongside the existing Platform-Owner-only
 * read surfaces (audit log, organizations, users), reusing their exact
 * guard pairing — no new authorization concept is introduced.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { AdminSubscriptionsService } from '../services/admin-subscriptions.service';
import type { AdminSubscriptionOverview } from '../dto/admin-subscription.contract';
import { PlatformSubscriptionAdjustmentsService } from '../services/platform-subscription-adjustments.service';
import {
  SubscriptionDaysAdjustmentDto,
  SubscriptionPlanChangeDto,
} from '../dto/subscription-adjustment.dto';
import type { TenantSubscriptionResponse } from '../../plans/dto/tenant-subscription.contract';

@Controller('platform-subscriptions')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class AdminSubscriptionsController {
  constructor(
    private readonly adminSubscriptionsService: AdminSubscriptionsService,
    private readonly adjustmentsService: PlatformSubscriptionAdjustmentsService,
  ) {}

  /**
   * Platform-wide subscription, trial and cancellation operations view.
   *
   * Cross-tenant by design — that is the entire purpose of a
   * platform-admin surface — and reachable only by a real platform owner.
   */
  @Get('overview')
  async getOverview(@Req() request: Request): Promise<AdminSubscriptionOverview> {
    // The acting user id is what unlocks the `is_platform_owner(...)`
    // RLS policies for the cross-tenant reads — see the service.
    return this.adminSubscriptionsService.getOverview(request.authContext!.userId);
  }

  /**
   * B0-BIL-06 — moves the date access runs to (trial end, or paid period
   * end) by `days`, with a written reason. A correction; see `grant-days`
   * for goodwill. Audited as `subscription.extended_by_platform`.
   */
  @Post(':organizationId/extend')
  @HttpCode(HttpStatus.OK)
  async extend(
    @Req() request: Request,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: SubscriptionDaysAdjustmentDto,
  ): Promise<TenantSubscriptionResponse> {
    return this.adjustmentsService.adjustDays(
      request.authContext!.userId,
      organizationId,
      'extend',
      body,
    );
  }

  /**
   * B0-BIL-06 — the same date move as `extend`, recorded as a goodwill
   * grant (`subscription.days_granted_by_platform`) so gifts can be
   * reported apart from corrections.
   */
  @Post(':organizationId/grant-days')
  @HttpCode(HttpStatus.OK)
  async grantDays(
    @Req() request: Request,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: SubscriptionDaysAdjustmentDto,
  ): Promise<TenantSubscriptionResponse> {
    return this.adjustmentsService.adjustDays(
      request.authContext!.userId,
      organizationId,
      'grant',
      body,
    );
  }

  /**
   * B0-BIL-06 — moves the organization to any non-archived plan (hidden
   * plans included), now or at the end of the paid period, re-granting
   * that plan's current limits. Audited as
   * `subscription.plan_changed_by_platform`.
   */
  @Post(':organizationId/change-plan')
  @HttpCode(HttpStatus.OK)
  async changePlan(
    @Req() request: Request,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() body: SubscriptionPlanChangeDto,
  ): Promise<TenantSubscriptionResponse> {
    return this.adjustmentsService.changePlan(
      request.authContext!.userId,
      organizationId,
      body,
    );
  }
}
