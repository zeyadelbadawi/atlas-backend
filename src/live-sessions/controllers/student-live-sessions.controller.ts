/**
 * The STUDENT surface for Live Sessions.
 *
 * Deliberately separate from `LiveSessionsController`, which is academy
 * management. A student is not an academy member and must never be routed
 * through `AcademyScopeGuard` — their authority comes from an ENROLLMENT,
 * which is a different fact entirely. Sharing one controller would have
 * meant one of the two audiences being checked by the wrong rule.
 *
 * `JwtAuthGuard` alone establishes identity; everything else is decided by
 * `LiveSessionAccessService` against the session's own academy and course.
 * The student supplies only a session id — the academy, course and
 * organization are all read FROM that session server-side, so substituting
 * another tenant's id changes nothing except that no enrollment matches.
 *
 * WHAT A STUDENT NEVER RECEIVES: a provider meeting id, a Zoom join URL,
 * or any credential. The join response carries a short-lived Atlas grant
 * and, once redeemed, an SDK signature scoped to one meeting and one role.
 */
import {
  Body,
  Controller,
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
import { IsString, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { LiveSessionAccessService } from '../services/live-session-access.service';
import { LiveProviderConnectionService } from '../services/live-provider-connection.service';
import { ZoomProvider } from '../providers/zoom.provider';

export class RedeemJoinGrantDto {
  @IsString()
  @MinLength(1, { message: 'validation:required' })
  token!: string;
}

@Controller('live-sessions')
@UseGuards(JwtAuthGuard)
export class StudentLiveSessionsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly accessService: LiveSessionAccessService,
    private readonly connectionService: LiveProviderConnectionService,
    private readonly zoomProvider: ZoomProvider,
  ) {}

  /**
   * Whether this student may join, and if not, WHY.
   *
   * Returns a reason rather than a bare 403 so the session screen can say
   * "starts in 20 minutes" or "your academy needs to reconnect Zoom"
   * instead of a dead button with no explanation.
   */
  @Get(':liveSessionId/eligibility')
  async eligibility(
    @Req() request: Request,
    @Param('liveSessionId') liveSessionId: string,
  ) {
    const userId = request.authContext!.userId;
    const context = await this.resolveSessionContext(liveSessionId);

    const eligibility = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.accessService.describeJoinEligibility(tx, {
        liveSessionId,
        userId,
        organizationId: context.organizationId,
      }),
    );

    return {
      joinable: eligibility.joinable,
      reason: eligibility.reason,
      isHost: eligibility.isHost,
      status: context.status,
      title: context.title,
      scheduledStartAt: context.scheduledStartAt.toISOString(),
      scheduledEndAt: context.scheduledEndAt.toISOString(),
    };
  }

  /**
   * Mints a single-use join grant.
   *
   * Every eligibility condition is re-checked here — the eligibility read
   * above is for display and is never trusted as authorization.
   */
  @Post(':liveSessionId/join')
  @HttpCode(HttpStatus.OK)
  async join(@Req() request: Request, @Param('liveSessionId') liveSessionId: string) {
    const userId = request.authContext!.userId;
    const context = await this.resolveSessionContext(liveSessionId);

    const grant = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.accessService.authorizeJoin(tx, {
        liveSessionId,
        userId,
        organizationId: context.organizationId,
      }),
    );

    // The token and its expiry only. No meeting id, no URL — those are
    // resolved on redemption, server-side.
    return { token: grant.token, expiresAt: grant.expiresAt.toISOString() };
  }

  /**
   * Redeems the grant and returns what the embedded SDK needs.
   *
   * THE GRANT IS CONSUMED HERE, exactly once. A replayed token matches no
   * unredeemed row and is refused; a token forwarded to a classmate fails
   * because the redemption predicate includes the user it was minted for.
   *
   * The SDK signature is generated per redemption, is scoped to one
   * meeting and one role, and expires on its own — so even the value
   * returned here is not a durable key to the room.
   */
  @Post(':liveSessionId/join/redeem')
  @HttpCode(HttpStatus.OK)
  async redeem(
    @Req() request: Request,
    @Param('liveSessionId') liveSessionId: string,
    @Body() body: RedeemJoinGrantDto,
  ) {
    const userId = request.authContext!.userId;
    const context = await this.resolveSessionContext(liveSessionId);

    const redeemed = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.accessService.redeemGrant(tx, { token: body.token, userId }),
    );

    // A grant is bound to one session; a token minted for a different
    // session cannot be spent here.
    if (redeemed.liveSessionId !== liveSessionId) {
      return { joinable: false as const, reason: 'grant_session_mismatch' };
    }

    const connection = await this.prisma.academyLiveProviderConnection.findUnique({
      where: { academyId: context.academyId },
    });
    if (!connection || connection.status !== 'connected') {
      return { joinable: false as const, reason: 'provider_unavailable' };
    }

    if (!context.providerMeetingId) {
      // The meeting was never created at the provider — typically because
      // the session has not been published yet.
      return { joinable: false as const, reason: 'provider_unavailable' };
    }

    const participant = await this.prisma.liveSessionParticipant.findUnique({
      where: { liveSessionId_userId: { liveSessionId, userId } },
      select: { participantKey: true },
    });
    if (!participant) {
      return { joinable: false as const, reason: 'not_enrolled' };
    }

    const credentials = await this.connectionService.decryptCredentials(connection);
    const signature = await this.zoomProvider.createJoinSignature(credentials, {
      providerMeetingId: context.providerMeetingId,
      role: redeemed.role === 'host' ? 'host' : 'attendee',
      participantKey: participant.participantKey,
    });

    return {
      joinable: true as const,
      // `sdkKey` is a PUBLIC client identifier — the SDK cannot run
      // without it. The SDK SECRET stays server-side and is only ever used
      // to sign; it is never part of this response.
      sdkKey: signature.sdkKey,
      signature: signature.signature,
      providerMeetingId: signature.providerMeetingId,
      expiresAt: signature.expiresAt.toISOString(),
    };
  }

  /**
   * Resolves the session's own tenancy.
   *
   * Read with the system client because a student has no tenant context
   * and this is what establishes which organization to run under. It
   * returns only non-sensitive fields, and every authorization decision
   * still happens afterwards against these server-derived values.
   */
  private async resolveSessionContext(liveSessionId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: liveSessionId },
      select: {
        id: true,
        academyId: true,
        title: true,
        status: true,
        providerMeetingId: true,
        scheduledStartAt: true,
        scheduledEndAt: true,
        academy: { select: { organizationId: true } },
      },
    });

    // Indistinguishable from "exists but not yours" — a 404 here must not
    // become an oracle for which session ids are real in other tenants.
    if (!session) throw new NotFoundException({ messageKey: 'errors.notFound' });

    return { ...session, organizationId: session.academy.organizationId };
  }
}
