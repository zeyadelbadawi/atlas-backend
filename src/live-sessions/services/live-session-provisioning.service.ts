/**
 * LiveSessionProvisioningService — the bridge between an Atlas session row
 * and a real meeting at the provider.
 *
 * WHAT WAS MISSING BEFORE THIS FILE EXISTED. The domain could create,
 * edit and reorder sessions, and the webhook pipeline could attribute
 * provider events back to them — but nothing ever asked Zoom to create a
 * meeting, so `provider_meeting_id` was never written. Every downstream
 * capability silently depended on a value that no code path produced:
 * joining resolved to `provider_unavailable`, webhook attribution matched
 * nothing, and recording import could never run. This is the transition
 * that makes the rest reachable.
 *
 * PUBLISHING IS A STATE CHANGE WITH AN EXTERNAL SIDE EFFECT, which is the
 * whole difficulty. The ordering here is deliberate:
 *
 *   1. a read-only transaction authorizes and validates
 *   2. the provider call happens OUTSIDE any transaction
 *   3. a second transaction commits the result and notifies
 *
 * Step 2 is outside a transaction on purpose. Holding a Postgres
 * transaction open across an external HTTP call pins a connection for as
 * long as Zoom takes to answer, and a provider slowdown would drain the
 * pool for the entire platform rather than for this one request.
 *
 * WHAT THAT ORDERING COSTS, AND HOW IT IS PAID. Splitting the work means a
 * meeting can exist at Zoom while the commit fails. That is handled with a
 * compensating cancel rather than ignored (see `publish`) — the honest
 * trade, because the alternative costs the connection pool.
 *
 * CONCURRENCY WITHOUT A NEW STATE. Two simultaneous publishes would each
 * create a meeting. The commit is a CONDITIONAL update matching only a
 * session that is still `draft` with no meeting id, so exactly one wins;
 * the loser cancels the meeting it created. No `provisioning` state was
 * invented for this — the existing model already expresses the semantics,
 * and the database decides the race rather than application code.
 *
 * RECORDING POLICY TRAVELS WITH THE MEETING. `autoRecord` is sent
 * explicitly on create AND on every update, so a session whose recording
 * toggle is turned off stops recording at the provider too, rather than
 * relying on Atlas declining to import afterwards.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { PrismaService } from '../../database/prisma.service';
import { ZoomOAuthService } from './zoom-oauth.service';
import { LiveSessionNotificationsService } from './live-session-notifications.service';
import { RecordingQuotaService } from './recording-quota.service';
import { ZoomProvider } from '../providers/zoom.provider';

/** Minutes, as the provider expects a meeting's duration. */
function durationMinutes(startAt: Date, endAt: Date): number {
  return Math.max(1, Math.round((endAt.getTime() - startAt.getTime()) / 60000));
}

@Injectable()
export class LiveSessionProvisioningService {
  private readonly logger = new Logger(LiveSessionProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly zoomOAuthService: ZoomOAuthService,
    private readonly notifications: LiveSessionNotificationsService,
    private readonly recordingQuotaService: RecordingQuotaService,
    private readonly zoomProvider: ZoomProvider,
  ) {}

  /**
   * `draft` → `scheduled`, creating the real meeting.
   *
   * Idempotent by design: a session that already has a meeting id is
   * returned unchanged rather than provisioned twice, so a retried request
   * cannot strand a second Zoom meeting.
   */
  async publish(args: {
    readonly academyId: string;
    readonly organizationId: string;
    readonly liveSessionId: string;
  }): Promise<{ providerMeetingId: string; alreadyPublished: boolean }> {
    const { academyId, organizationId, liveSessionId } = args;

    const session = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        tx.liveSession.findFirst({
          where: { id: liveSessionId, academyId },
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            courseId: true,
            providerMeetingId: true,
            scheduledStartAt: true,
            scheduledEndAt: true,
            recordingEnabled: true,
          },
        }),
    );

    if (!session) {
      throw new ForbiddenException({ messageKey: 'errors.notFound' });
    }
    if (session.providerMeetingId) {
      return { providerMeetingId: session.providerMeetingId, alreadyPublished: true };
    }
    if (session.status === 'cancelled' || session.status === 'ended') {
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.notPublishable',
      });
    }

    /*
      RECORDING ALLOWANCE IS CHECKED HERE, NOT CHARGED HERE.

      Telling an instructor at publish time that their plan has no
      recording allowance left is useful; silently creating a meeting that
      will refuse to record is not. The CHARGE still happens later, when a
      recording actually completes — a session that is published and never
      runs must not consume allowance.
    */
    if (session.recordingEnabled) {
      const allowance = await this.tenancyContextService.runInTenantContext(
        organizationId,
        (tx) => this.recordingQuotaService.describeUsage(tx, organizationId),
      );
      if (allowance.remaining !== null && allowance.remaining <= 0) {
        throw new ForbiddenException({
          messageKey: 'errors.liveSessions.recordingQuotaExceeded',
        });
      }
    }

    const accessToken = await this.requireAccessToken(academyId, organizationId);

    // OUTSIDE any transaction — see the class comment.
    const created = await this.zoomProvider.createMeeting(accessToken, {
      topic: session.title,
      agenda: session.description ?? undefined,
      startAt: session.scheduledStartAt,
      durationMinutes: durationMinutes(session.scheduledStartAt, session.scheduledEndAt),
      autoRecord: session.recordingEnabled,
    });

    try {
      const claimed = await this.tenancyContextService.runInTenantContext(
        organizationId,
        async (tx) => {
          // THE RACE IS DECIDED HERE, by the database. Only a session
          // still unprovisioned can be claimed; a concurrent publish that
          // got there first leaves this matching zero rows.
          const result = await tx.liveSession.updateMany({
            where: {
              id: liveSessionId,
              academyId,
              providerMeetingId: null,
              status: { in: ['draft', 'scheduled'] },
            },
            data: {
              providerMeetingId: created.providerMeetingId,
              status: 'scheduled',
              failureReason: null,
            },
          });

          if (result.count !== 1) return false;

          // Inside the same transaction as the state change, per the
          // fan-out contract: a rolled-back publish cannot leave students
          // told about a class that does not exist.
          await this.notifications.notifyEnrolledStudents(tx, {
            liveSessionId,
            courseId: session.courseId,
            academyId,
            title: session.title,
            scheduledStartAt: session.scheduledStartAt,
            event: 'scheduled',
          });

          return true;
        },
      );

      if (!claimed) {
        // Somebody else published first. The meeting just created is now
        // an orphan and is cancelled rather than left running in the
        // academy's Zoom account.
        await this.safeCancelAtProvider(accessToken, created.providerMeetingId);
        const current = await this.tenancyContextService.runInTenantContext(
          organizationId,
          (tx) =>
            tx.liveSession.findFirst({
              where: { id: liveSessionId },
              select: { providerMeetingId: true },
            }),
        );
        return {
          providerMeetingId: current?.providerMeetingId ?? created.providerMeetingId,
          alreadyPublished: true,
        };
      }
    } catch (error) {
      // The commit failed after the meeting was created. Compensate, so a
      // failed publish does not accumulate meetings nobody can reach.
      await this.safeCancelAtProvider(accessToken, created.providerMeetingId);
      throw error;
    }

    return { providerMeetingId: created.providerMeetingId, alreadyPublished: false };
  }

  /**
   * Pushes a schedule/title/recording change to the provider and tells the
   * students whose plans just changed.
   *
   * Only called for a session that is already provisioned — an unpublished
   * draft has no provider meeting to update, and its students have not
   * been told anything to correct.
   */
  async applyUpdate(args: {
    readonly academyId: string;
    readonly organizationId: string;
    readonly liveSessionId: string;
    /** Whether the times actually moved — decides notification, not the provider call. */
    readonly scheduleChanged: boolean;
  }): Promise<void> {
    const { academyId, organizationId, liveSessionId } = args;

    const session = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        tx.liveSession.findFirst({
          where: { id: liveSessionId, academyId },
          select: {
            id: true,
            title: true,
            description: true,
            courseId: true,
            status: true,
            providerMeetingId: true,
            scheduledStartAt: true,
            scheduledEndAt: true,
            recordingEnabled: true,
          },
        }),
    );

    if (!session?.providerMeetingId) return;
    if (session.status === 'cancelled' || session.status === 'ended') return;

    const accessToken = await this.requireAccessToken(academyId, organizationId);

    await this.zoomProvider.updateMeeting(accessToken, session.providerMeetingId, {
      topic: session.title,
      agenda: session.description ?? undefined,
      startAt: session.scheduledStartAt,
      durationMinutes: durationMinutes(session.scheduledStartAt, session.scheduledEndAt),
      // Re-asserted on every update, so turning recording off genuinely
      // stops it at the provider rather than only at import time.
      autoRecord: session.recordingEnabled,
    });

    if (!args.scheduleChanged) return;

    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      /*
        A NEW TIME MEANS A NEW REMINDER. Clearing the starting-soon stamp
        is what lets the sweep send one for the time that now applies —
        without it, a class moved from Monday to Friday would reuse
        Monday's "already reminded" mark and nobody would be told.
      */
      await tx.liveSession.update({
        where: { id: liveSessionId },
        data: { startingSoonNotifiedAt: null },
      });

      await this.notifications.notifyEnrolledStudents(tx, {
        liveSessionId,
        courseId: session.courseId,
        academyId,
        title: session.title,
        scheduledStartAt: session.scheduledStartAt,
        event: 'rescheduled',
      });
    });
  }

  /**
   * Cancels at the provider and tells the students.
   *
   * The Atlas row is already `cancelled` by the time this runs — Atlas is
   * authoritative, and a Zoom outage must not prevent an instructor from
   * cancelling a class. A provider call that fails is logged and left; the
   * meeting becomes an empty room nobody is authorized to enter, because
   * `describeJoinEligibility` refuses a cancelled session regardless of
   * what exists at Zoom.
   */
  async applyCancellation(args: {
    readonly academyId: string;
    readonly organizationId: string;
    readonly liveSessionId: string;
  }): Promise<void> {
    const { academyId, organizationId, liveSessionId } = args;

    const session = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        tx.liveSession.findFirst({
          where: { id: liveSessionId, academyId },
          select: {
            id: true,
            title: true,
            courseId: true,
            providerMeetingId: true,
            scheduledStartAt: true,
          },
        }),
    );
    if (!session) return;

    if (session.providerMeetingId) {
      try {
        const accessToken = await this.requireAccessToken(academyId, organizationId);
        await this.zoomProvider.cancelMeeting(accessToken, session.providerMeetingId);
      } catch {
        this.logger.warn(
          { liveSessionId },
          'Provider cancellation failed; Atlas cancellation stands and joining is refused.',
        );
      }
    }

    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      this.notifications.notifyEnrolledStudents(tx, {
        liveSessionId,
        courseId: session.courseId,
        academyId,
        title: session.title,
        scheduledStartAt: session.scheduledStartAt,
        event: 'cancelled',
      }),
    );
  }

  /**
   * The academy's credentials, or a refusal naming the actual problem.
   *
   * A missing or unhealthy connection is a configuration fact the
   * instructor can fix, so it is reported as its own message rather than
   * surfacing as a provider error later.
   */
  private async requireAccessToken(
    academyId: string,
    organizationId: string,
  ): Promise<string> {
    const connection = await this.prisma.academyLiveProviderConnection.findUnique({
      where: { academyId },
      select: { status: true },
    });
    if (!connection || connection.status !== 'connected') {
      throw new ForbiddenException({
        messageKey: 'errors.liveSessions.providerNotConnected',
      });
    }
    // Refresh and rotation are the OAuth service's business, not this
    // one's — every caller gets a token that is already valid.
    return this.zoomOAuthService.getAccessTokenForAcademy(academyId, organizationId);
  }

  /**
   * Best-effort compensating cancel.
   *
   * Never throws: it runs on paths that are ALREADY failing, and letting
   * it replace the original error would hide why the publish failed.
   */
  private async safeCancelAtProvider(
    accessToken: string,
    providerMeetingId: string,
  ): Promise<void> {
    try {
      await this.zoomProvider.cancelMeeting(accessToken, providerMeetingId);
    } catch {
      // Logged without the provider payload; an orphaned meeting is an
      // operational annoyance, not a security or correctness problem.
      this.logger.warn(
        'Compensating provider cancellation failed after a failed publish.',
      );
    }
  }
}
