/**
 * Zoom authorization — starting it, and receiving it back.
 *
 * TWO ENDPOINTS, BOTH AUTHENTICATED ATLAS API CALLS:
 *
 *   POST .../connection/authorize      — the owner presses Connect.
 *                                        Returns where to send them.
 *   POST /live-sessions/oauth/callback — the Atlas page the customer
 *                                        lands back on forwards what Zoom
 *                                        returned. Carries no academy,
 *                                        because the academy is whatever
 *                                        the stored state says it is.
 *
 * WHY ZOOM DOES NOT REDIRECT STRAIGHT TO THIS CONTROLLER. It is the
 * obvious design and it cannot work here: Zoom returns the customer as a
 * top-level browser NAVIGATION, and Atlas authenticates every request
 * with a bearer token that the SPA holds in memory. A navigation carries
 * no `Authorization` header, so `JwtAuthGuard` would reject Zoom's
 * redirect with a 401 and the customer would land on raw JSON straight
 * after pressing Allow. Worse, the identity needed to make sense of the
 * callback at all would be missing: `live_provider_oauth_states` is
 * protected by a user-self RLS policy keyed on `app.current_user_id`, so
 * without a known user there is no context in which the state row is even
 * visible.
 *
 * So Zoom's registered redirect URI points at the Atlas CONNECTION PAGE.
 * That page loads inside the customer's existing session, reads `code`
 * and `state` off its own query string, and forwards them here on a
 * normal authenticated request. The browser never needs a header it
 * cannot send, and the user binding below stays real.
 *
 * WHY THE CALLBACK TAKES NO ACADEMY PARAMETER. Zoom returns to one fixed,
 * pre-registered redirect URI; Atlas cannot vary it per academy. That is
 * a security property rather than a limitation: with nothing
 * tenant-shaped in the round trip, there is nothing for a returning
 * browser to tamper with. The academy is read from the state row written
 * server-side when the flow began.
 *
 * OWNER-ONLY, ENFORCED HERE. Connecting Zoom activates Live Sessions for
 * the whole academy and binds a customer's Zoom account, so it sits in
 * the owner-exclusive tier alongside billing and add-on lifecycle — not
 * with day-to-day academy configuration a Manager performs. The frontend
 * hides the control; this is what actually stops a Manager who calls the
 * endpoint directly.
 *
 * NOTHING SENSITIVE IS LOGGED OR RETURNED: no authorization code, no
 * state, no access token, no refresh token, no client secret.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { LiveProviderConnectionService } from '../services/live-provider-connection.service';
import { ZoomOAuthService } from '../services/zoom-oauth.service';
import { CompleteZoomAuthorizationDto } from '../dto/zoom-oauth.dto';

/**
 * The owner-exclusive permission this flow requires.
 *
 * `tenant.addon.view` is reused deliberately rather than inventing a new
 * string. Two reasons, both practical:
 *
 *   1. It is already owner-exclusive — `ORGANIZATION_MANAGER_PERMISSIONS`
 *      carries no `tenant.*` string at all, by explicit product decision.
 *   2. `organizationPermissions` is read from the stored
 *      `organization_memberships.permissions` row. A NEW string would be
 *      absent from every membership that already exists, locking every
 *      current owner out until a backfill ran — the exact failure mode
 *      `organization-permissions.constants.ts` documents having hit once
 *      already.
 *
 * It is also semantically right: Live Sessions IS an add-on, and this is
 * the step that activates it. `AddOnsLifecycleController` gates
 * install/enable on the same owner tier for the same reason.
 */
const OWNER_CONNECT_PERMISSION = 'tenant.addon.view';

@Controller()
export class LiveProviderOAuthController {
  constructor(
    private readonly oauthService: ZoomOAuthService,
    private readonly connectionService: LiveProviderConnectionService,
  ) {}

  /**
   * Begins an authorization and returns where to send the owner.
   *
   * Returns the URL rather than issuing a redirect: this is an
   * authenticated XHR from the dashboard, and a 302 on an XHR is followed
   * by the fetch layer rather than by the user's browser window.
   */
  @Post('academies/:id/live-sessions/connection/authorize')
  @UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
  @HttpCode(HttpStatus.OK)
  async authorize(@Req() request: Request) {
    const { academyId, organizationId } = request.academyContext!;
    this.assertOwner(request);

    const { authorizationUrl, expiresAt } = await this.oauthService.createAuthorization({
      // Both derived from the AUTHENTICATED context, never from the body.
      academyId,
      organizationId,
      userId: request.authContext!.userId,
    });

    return { authorizationUrl, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Completes an authorization the customer has just granted at Zoom.
   *
   * NOT ACADEMY-SCOPED, AND SO NOT BEHIND `AcademyScopeGuard`: the
   * academy is not supplied by the caller at all. It comes from the state
   * row, which is why a Manager cannot reach another academy's connection
   * by calling this endpoint — there is no academy id here for them to
   * change. The owner check that mattered ran when the state was minted.
   *
   * THE STATE IS SPENT BEFORE THE CODE IS EXCHANGED, so a forged or
   * replayed callback never reaches Zoom's token endpoint at all. The
   * match requires the state to be unconsumed, unexpired, AND to belong
   * to the user making this call.
   */
  @Post('live-sessions/oauth/callback')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async callback(
    @Req() request: Request,
    @Body() body: CompleteZoomAuthorizationDto,
  ): Promise<{ status: string }> {
    const userId = request.authContext!.userId;

    const resolved = await this.oauthService.consumeState(body.state, userId);
    if (!resolved) {
      // Expired, already spent, or never belonged to this user — all one
      // refusal, because distinguishing them tells a prober which.
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.authorizationInvalid',
      });
    }

    try {
      await this.connectionService.completeOAuthConnection({
        academyId: resolved.academyId,
        organizationId: resolved.organizationId,
        actorUserId: userId,
        code: body.code,
      });
    } catch (caught) {
      // The one failure worth distinguishing: this Zoom account is
      // already bound to a different academy. That is actionable — the
      // customer picked the wrong Zoom login — and it is not a leak,
      // because they already know which account they just authorized.
      if (caught instanceof Error && caught.message === 'ACCOUNT_ALREADY_BOUND') {
        throw new ConflictException({
          messageKey: 'errors.liveSessions.accountAlreadyConnected',
        });
      }

      // Everything else is generic on purpose: relaying precisely why
      // Zoom refused is how provider internals leak to a browser.
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.authorizationFailed',
      });
    }

    return { status: 'connected' };
  }

  private assertOwner(request: Request): void {
    const permissions = request.academyContext?.organizationPermissions ?? [];
    if (!permissions.includes(OWNER_CONNECT_PERMISSION)) {
      throw new ForbiddenException({ messageKey: 'errors.forbidden' });
    }
  }
}
