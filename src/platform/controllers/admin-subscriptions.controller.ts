/**
 * AdminSubscriptionsController — `GET /platform/subscriptions/overview`.
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
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { AdminSubscriptionsService } from '../services/admin-subscriptions.service';
import type { AdminSubscriptionOverview } from '../dto/admin-subscription.contract';

@Controller('platform/subscriptions')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class AdminSubscriptionsController {
  constructor(private readonly adminSubscriptionsService: AdminSubscriptionsService) {}

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
}
