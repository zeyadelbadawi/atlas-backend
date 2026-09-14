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
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { LiveSessionAccessService } from '../services/live-session-access.service';
import { LiveProviderConnectionService } from '../services/live-provider-connection.service';
import { ZoomProvider } from '../providers/zoom.provider';

/**
 * What a student's client is told about a session.
 *
 * DELIBERATELY ABSENT: `providerMeetingId`, any join URL, the host's
 * email, and the recording's storage location. A curriculum render reaches
 * every enrolled browser; anything in this shape is effectively public to
 * the class, so it carries only what the screen actually draws.
 */
export interface StudentLiveSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly status: string;
  readonly sectionId?: string;
  readonly scheduledStartAt: string;
  readonly scheduledEndAt: string;
  readonly host?: { readonly id: string; readonly name: string };
  readonly recordingAvailable: boolean;
}

export class RedeemJoinGrantDto {
  @IsString()
  @MinLength(1, { message: 'validation:required' })
  token!: string;
}

@Controller('live-sessions')
@UseGuards(JwtAuthGuard)
export class StudentLiveSessionsController {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly accessService: LiveSessionAccessService,
    private readonly connectionService: LiveProviderConnectionService,
    private readonly zoomProvider: ZoomProvider,
  ) {}

  /**
   * The Live Sessions of one course, for a student who is enrolled in it.
   *
   * ENROLLMENT IS CHECKED BEFORE ANY SESSION IS READ, not filtered
   * afterwards. A student who is not enrolled gets an empty list rather
   * than a 403: whether a course HAS live sessions is itself information,
   * and answering differently for "enrolled, none scheduled" and "not
   * enrolled" would turn this endpoint into a probe for other academies'
   * curricula.
   *
   * Draft sessions are excluded. A draft has no provider meeting and no
   * commitment behind it; showing students a class that may never happen
   * is worse than showing nothing.
   */
  @Get('courses/:courseId')
  async listForCourse(
    @Req() request: Request,
    @Param('courseId') courseId: string,
  ): Promise<readonly StudentLiveSessionSummary[]> {
    const userId = request.authContext!.userId;

    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const enrollment = await tx.enrollment.findFirst({
        where: {
          studentId: userId,
          courseId,
          // The same predicate the join check uses — one definition of
          // "genuinely has this course", not two that can drift.
          status: { in: ['enrolled', 'completed'] },
        },
        select: { academyId: true },
      });
      if (!enrollment) return [];

      const sessions = await tx.liveSession.findMany({
        where: {
          courseId,
          // Matched on the ENROLLMENT's academy, so a session belonging to
          // another academy's course of the same id cannot appear here.
          academyId: enrollment.academyId,
          status: { not: 'draft' },
        },
        orderBy: [{ scheduledStartAt: 'asc' }],
        select: {
          id: true,
          title: true,
          description: true,
          status: true,
          sectionId: true,
          scheduledStartAt: true,
          scheduledEndAt: true,
          hostUser: { select: { id: true, name: true } },
          recording: { select: { status: true, availableAt: true } },
        },
      });

      return sessions.map((session) => ({
        id: session.id,
        title: session.title,
        description: session.description ?? undefined,
        status: session.status,
        sectionId: session.sectionId ?? undefined,
        scheduledStartAt: session.scheduledStartAt.toISOString(),
        scheduledEndAt: session.scheduledEndAt.toISOString(),
        host: session.hostUser
          ? { id: session.hostUser.id, name: session.hostUser.name }
          : undefined,
        // Presence only — whether a recording EXISTS, never where it is.
        // Opening it still goes through the existing media authorization.
        recordingAvailable: session.recording?.status === 'available',
      }));
    });
  }

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
    const context = await this.resolveSessionContext(liveSessionId, userId);

    /*
      THE TENANT CONTEXT IS ENTERED ONLY AFTER RLS ALREADY AGREED.

      `resolveSessionContext` ran in USER context, so RLS has independently
      confirmed this caller is either enrolled in the course or is the
      session's host. Only then is the session's own organization — read
      from the row, never from the request — used to read the tenant-owned
      facts eligibility needs (the provider connection, the add-on state).

      The alternative would have been student-readable policies on
      `academy_live_provider_connections`, which holds the encrypted Zoom
      credentials. Granting a student row access to that table to read one
      status column would be a real widening of RLS; deriving the tenant
      after an independent gate is not.
    */
    const eligibility = await this.tenancyContextService.runInTenantContext(
      context.organizationId,
      (tx) =>
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
    const context = await this.resolveSessionContext(liveSessionId, userId);

    // Same two-stage rule as `eligibility`: RLS agreed in user context
    // above, and the participant/grant writes need the tenant insert
    // policies. Every eligibility condition is re-checked inside.
    const grant = await this.tenancyContextService.runInTenantContext(
      context.organizationId,
      (tx) =>
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
    const context = await this.resolveSessionContext(liveSessionId, userId);

    const redeemed = await this.tenancyContextService.runInTenantContext(
      context.organizationId,
      (tx) => this.accessService.redeemGrant(tx, { token: body.token, userId }),
    );

    // A grant is bound to one session; a token minted for a different
    // session cannot be spent here.
    if (redeemed.liveSessionId !== liveSessionId) {
      return { joinable: false as const, reason: 'grant_session_mismatch' };
    }

    const connection = await this.tenancyContextService.runInTenantContext(
      context.organizationId,
      (tx) =>
        tx.academyLiveProviderConnection.findUnique({
          where: { academyId: context.academyId },
        }),
    );
    if (!connection || connection.status !== 'connected') {
      return { joinable: false as const, reason: 'provider_unavailable' };
    }

    if (!context.providerMeetingId) {
      // The meeting was never created at the provider — typically because
      // the session has not been published yet.
      return { joinable: false as const, reason: 'provider_unavailable' };
    }

    const participant = await this.tenancyContextService.runInTenantContext(
      context.organizationId,
      (tx) =>
        tx.liveSessionParticipant.findUnique({
          where: { liveSessionId_userId: { liveSessionId, userId } },
          select: { participantKey: true },
        }),
    );
    if (!participant) {
      return { joinable: false as const, reason: 'not_enrolled' };
    }

    const isHost = redeemed.role === 'host';
    const credentials = await this.connectionService.decryptCredentials(connection);
    const signature = await this.zoomProvider.createJoinSignature(credentials, {
      providerMeetingId: context.providerMeetingId,
      role: isHost ? 'host' : 'attendee',
      participantKey: participant.participantKey,
    });

    /*
      THE HOST START TOKEN, AND ONLY FOR THE HOST.

      Atlas creates meetings that cannot be joined before the host, so
      without this the host waits in their own classroom and nobody gets
      in. `redeemed.role` comes from the GRANT — minted server-side after
      the eligibility check — never from anything the client sent, so a
      student cannot ask for one by claiming to be the host.

      A failure here is not fatal to the join: the signature is still
      valid, and the host simply lands in the waiting state rather than
      getting a hard error with no way forward.
    */
    let hostToken: string | undefined;
    if (isHost) {
      try {
        hostToken = await this.zoomProvider.fetchHostZak(credentials);
      } catch {
        // Never logged with the provider payload — this path handles a
        // credential.
        hostToken = undefined;
      }
    }

    return {
      joinable: true as const,
      // `sdkKey` is a PUBLIC client identifier — the SDK cannot run
      // without it. The SDK SECRET stays server-side and is only ever used
      // to sign; it is never part of this response.
      sdkKey: signature.sdkKey,
      signature: signature.signature,
      providerMeetingId: signature.providerMeetingId,
      expiresAt: signature.expiresAt.toISOString(),
      isHost,
      ...(hostToken ? { hostToken } : {}),
    };
  }

  /**
   * Resolves the session's own tenancy — under the CALLER's user context.
   *
   * THIS READ IS THE FIRST AUTHORIZATION GATE, not a lookup. Running it in
   * user context means RLS itself decides whether this caller may see this
   * session: `live_sessions_enrolled_student_select` matches only a
   * student with a real enrolment, and `live_sessions_host_select` (P48)
   * matches only the session's own host. A caller with neither
   * relationship gets nothing back and a 404 — indistinguishable from
   * "does not exist", so this cannot become an oracle for which session
   * ids are real in other tenants.
   *
   * IT USED TO USE THE PLAIN CLIENT, and that was a bug: `live_sessions`
   * is FORCE RLS, so a client with no context matched no policy and every
   * student got a 404 on their own class. Found by end-to-end testing
   * against the real database, where unit tests had mocked the client.
   *
   * The organization id returned here is derived FROM the session, never
   * accepted from the request — which is what makes it safe to use as a
   * tenant context afterwards.
   */
  private async resolveSessionContext(liveSessionId: string, userId: string) {
    const session = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.liveSession.findFirst({
        where: { id: liveSessionId },
        select: {
          id: true,
          academyId: true,
          title: true,
          status: true,
          providerMeetingId: true,
          scheduledStartAt: true,
          scheduledEndAt: true,
        },
      }),
    );

    // Indistinguishable from "exists but not yours" — a 404 here must not
    // become an oracle for which session ids are real in other tenants.
    if (!session) throw new NotFoundException({ messageKey: 'errors.notFound' });

    /*
      The organization is resolved SEPARATELY, not through a nested
      relation. A student holds no policy on `academies`, so joining to it
      in user context returns null and fails the entire query — the 500
      this replaced. See `resolveOrganizationForAcademy`.
    */
    const organizationId = await this.connectionService.resolveOrganizationForAcademy(
      session.academyId,
    );
    if (!organizationId) throw new NotFoundException({ messageKey: 'errors.notFound' });

    return { ...session, organizationId };
  }
}
