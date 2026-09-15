/**
 * LiveSessionSweepService — the two things that must happen on a clock
 * rather than in response to a request.
 *
 *   1. STARTING-SOON REMINDERS. Nobody presses a button fifteen minutes
 *      before a class; the reminder only exists if something notices the
 *      time passing.
 *   2. ATTENDANCE RECONCILIATION. Live webhooks are the fast path and are
 *      occasionally lost or reordered. The provider's post-session report
 *      is the authoritative tally, and it becomes available minutes AFTER
 *      the meeting ends — so fetching it is inherently a scheduled job.
 *
 * ONE SWEEP, NOT TWO SCHEDULERS. Both live here for the same reason
 * `SubscriptionSweepService` handles trial expiry and usage recompute
 * together: the codebase's rule is one mechanism, one repeatable job, one
 * processor. A second scheduler for the second concern would be exactly
 * the parallel system this design forbids.
 *
 * HOW IT STAYS TENANT-SAFE WHILE RUNNING FOR EVERYONE. Candidate
 * selection is a cross-tenant SELECT under platform-owner context — the
 * same read-only mechanism webhook attribution uses, permitted by P46's
 * SELECT-only policies. Every WRITE then runs inside the owning tenant's
 * own context, under the ordinary tenant policies. The sweep therefore
 * never holds cross-tenant write authority, and RLS still independently
 * agrees with every change it makes.
 *
 * IDEMPOTENCY IS A COLUMN, NOT A HOPE. `starting_soon_notified_at` and
 * `attendance_reconciled_at` are stamped as part of the same transaction
 * as the work they describe. A tick that crashes halfway is retried and
 * finds its own completed work already marked; a tick that runs
 * concurrently with another (two app instances, overlapping ticks) is
 * decided by a CONDITIONAL update rather than by a read-then-write.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { LiveSessionNotificationsService } from './live-session-notifications.service';
import { ZoomOAuthService } from './zoom-oauth.service';
import { AttendanceService } from './attendance.service';
import { ZoomProvider } from '../providers/zoom.provider';
import {
  LIVE_SESSION_SWEEP_MAX_PER_TICK,
  MAX_RECONCILIATION_ATTEMPTS,
  RECONCILIATION_DELAY_MS,
  STARTING_SOON_GRACE_MS,
  STARTING_SOON_WINDOW_MS,
} from '../queue/live-session-sweep.types';

export interface LiveSessionSweepResult {
  readonly remindersSent: number;
  readonly sessionsReconciled: number;
  readonly reconciliationFailures: number;
}

@Injectable()
export class LiveSessionSweepService {
  private readonly logger = new Logger(LiveSessionSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly notifications: LiveSessionNotificationsService,
    private readonly zoomOAuthService: ZoomOAuthService,
    private readonly attendanceService: AttendanceService,
    private readonly zoomProvider: ZoomProvider,
  ) {}

  async run(now: Date = new Date()): Promise<LiveSessionSweepResult> {
    const remindersSent = await this.sendStartingSoonReminders(now);
    const reconciliation = await this.reconcileEndedSessions(now);

    return {
      remindersSent,
      sessionsReconciled: reconciliation.reconciled,
      reconciliationFailures: reconciliation.failed,
    };
  }

  /**
   * Reminds students about classes about to start.
   *
   * THE QUERY IS THE SAFETY MECHANISM. Only `scheduled` sessions are
   * selected, which is what excludes:
   *
   *   cancelled — a cancelled class must never produce a reminder, and
   *               this is enforced by the status filter rather than by a
   *               check somebody could forget.
   *   draft     — never announced, so never reminded.
   *   live/ended— already started; a reminder would be absurd.
   *
   * A RESCHEDULED session is handled without a special case: the
   * reschedule clears `starting_soon_notified_at` and the row reappears as
   * a candidate for its NEW time. The superseded time is gone from the
   * row, so it cannot be reminded about.
   */
  private async sendStartingSoonReminders(now: Date): Promise<number> {
    const windowEnd = new Date(now.getTime() + STARTING_SOON_WINDOW_MS);
    const windowStart = new Date(now.getTime() - STARTING_SOON_GRACE_MS);

    const candidates = await this.selectAcrossTenants((tx) =>
      tx.liveSession.findMany({
        where: {
          status: 'scheduled',
          startingSoonNotifiedAt: null,
          scheduledStartAt: { gte: windowStart, lte: windowEnd },
        },
        select: {
          id: true,
          courseId: true,
          academyId: true,
          title: true,
          scheduledStartAt: true,
          academy: { select: { organizationId: true } },
        },
        orderBy: { scheduledStartAt: 'asc' },
        take: LIVE_SESSION_SWEEP_MAX_PER_TICK,
      }),
    );

    let sent = 0;

    for (const session of candidates) {
      const organizationId = session.academy.organizationId;
      try {
        const notified = await this.tenancyContextService.runInTenantContext(
          organizationId,
          async (tx) => {
            /*
              THE CLAIM COMES FIRST, and it is conditional.

              Two instances sweeping at the same moment both selected this
              row. Only the one whose UPDATE matches (the stamp is still
              null) proceeds to fan out; the other matches zero rows and
              does nothing. Without this, a class of 200 would receive two
              reminders each — and `dedupeKey` alone would not save them,
              because dedupe is per notification row, not per fan-out.
            */
            const claimed = await tx.liveSession.updateMany({
              where: {
                id: session.id,
                startingSoonNotifiedAt: null,
                // Re-checked inside the transaction: the session may have
                // been cancelled in the seconds since it was selected.
                status: 'scheduled',
              },
              data: { startingSoonNotifiedAt: now },
            });
            if (claimed.count !== 1) return false;

            await this.notifications.notifyEnrolledStudents(tx, {
              liveSessionId: session.id,
              courseId: session.courseId,
              academyId: session.academyId,
              title: session.title,
              scheduledStartAt: session.scheduledStartAt,
              event: 'starting_soon',
            });
            return true;
          },
        );

        if (notified) sent += 1;
      } catch (error) {
        // One tenant's failure must not abandon every other tenant's
        // reminders. The stamp rolls back with the transaction, so this
        // session is retried on the next tick — while it is still inside
        // the window.
        this.logger.warn(
          { liveSessionId: session.id },
          'Starting-soon reminder failed; will retry on the next tick.',
        );
        void error;
      }
    }

    return sent;
  }

  /**
   * Applies the provider's authoritative participant report to ended
   * sessions.
   *
   * WHY THIS IS NOT DONE ON `meeting.ended`. The report does not exist
   * yet at that moment. Asking immediately returns an empty list, which
   * would look exactly like "nobody attended" — and replacing real webhook
   * intervals with that emptiness would destroy the evidence.
   * `RECONCILIATION_DELAY_MS` is what separates "not ready" from "nobody
   * came".
   *
   * THE AUTHORITY HIERARCHY IS PRESERVED, NOT REDEFINED.
   * `reconcileFromProviderReport` replaces only `provider_webhook` and
   * `sdk_event` rows; a `manual` override is a human decision and survives
   * untouched. This job supplies the top tier — it never demotes one.
   */
  private async reconcileEndedSessions(
    now: Date,
  ): Promise<{ reconciled: number; failed: number }> {
    const endedBefore = new Date(now.getTime() - RECONCILIATION_DELAY_MS);

    const candidates = await this.selectAcrossTenants((tx) =>
      tx.liveSession.findMany({
        where: {
          status: 'ended',
          attendanceReconciledAt: null,
          reconciliationAttempts: { lt: MAX_RECONCILIATION_ATTEMPTS },
          endedAt: { not: null, lte: endedBefore },
          providerMeetingId: { not: null },
        },
        select: {
          id: true,
          academyId: true,
          providerMeetingId: true,
          academy: { select: { organizationId: true } },
        },
        orderBy: { endedAt: 'asc' },
        take: LIVE_SESSION_SWEEP_MAX_PER_TICK,
      }),
    );

    let reconciled = 0;
    let failed = 0;

    for (const session of candidates) {
      const organizationId = session.academy.organizationId;

      /*
        THE ATTEMPT IS COUNTED BEFORE THE PROVIDER IS CALLED.

        Counting afterwards would mean a call that throws — or a worker
        killed mid-call — never increments, and the session is retried
        forever. Charging the attempt up front makes `MAX_RECONCILIATION_
        ATTEMPTS` a real bound rather than an aspiration.
      */
      await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
        tx.liveSession.updateMany({
          where: { id: session.id },
          data: { reconciliationAttempts: { increment: 1 } },
        }),
      );

      try {
        const connection = await this.prisma.academyLiveProviderConnection.findUnique({
          where: { academyId: session.academyId },
        });
        if (!connection || connection.status !== 'connected') {
          // Nothing to reconcile against. Not an error — the academy
          // disconnected, and the webhook record stands.
          continue;
        }

        // A dead authorization simply means no report is available. The
        // attempt is already counted, the webhook intervals stand, and
        // the connection has already been moved to `reconnect_required`
        // by the OAuth service — nothing to do here but move on.
        const accessToken = await this.zoomOAuthService.getAccessTokenForAcademy(
          session.academyId,
          organizationId,
        );
        const intervals = await this.zoomProvider.fetchParticipantIntervals(
          accessToken,
          session.providerMeetingId!,
        );

        if (intervals.length === 0) {
          /*
            AN EMPTY REPORT IS NEVER APPLIED.

            It is indistinguishable from "the report is not ready yet", and
            treating it as truth would delete genuine webhook attendance
            and record that nobody turned up. Left unreconciled so a later
            tick can try again — and if the attempts run out, the webhook
            intervals remain as the record, which is the honest outcome.
          */
          continue;
        }

        await this.tenancyContextService.runInTenantContext(
          organizationId,
          async (tx) => {
            // Replacement and stamp in ONE transaction: a crash between
            // them would otherwise leave a session marked reconciled with
            // its intervals deleted and not yet rewritten.
            const result = await this.attendanceService.reconcileFromProviderReport(tx, {
              liveSessionId: session.id,
              intervals,
            });

            await tx.liveSession.update({
              where: { id: session.id },
              data: { attendanceReconciledAt: now },
            });

            if (result.unmatched > 0) {
              this.logger.warn(
                { liveSessionId: session.id, unmatched: result.unmatched },
                'Provider report contained participants Atlas never authorized.',
              );
            }
          },
        );

        reconciled += 1;
      } catch (error) {
        failed += 1;
        // Provider-agnostic. The attempt is already counted, so a
        // permanently failing session retires on its own.
        this.logger.warn(
          { liveSessionId: session.id },
          'Attendance reconciliation failed for this session.',
        );
        void error;
      }
    }

    return { reconciled, failed };
  }

  /**
   * Cross-tenant candidate selection, read-only.
   *
   * Platform-owner context is the SAME mechanism webhook attribution uses,
   * and P46 grants it SELECT only. Choosing it here rather than adding a
   * cross-tenant write policy is deliberate: the sweep needs to SEE every
   * tenant's due work, and it never needs authority to WRITE outside a
   * tenant's own context — every mutation above runs inside the owning
   * organization's context instead.
   */
  private async selectAcrossTenants<T>(
    read: (tx: Prisma.TransactionClient) => Promise<readonly T[]>,
  ): Promise<readonly T[]> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.error(
        'No platform owner exists — the Live Sessions sweep cannot select candidates.',
      );
      return [];
    }
    return this.tenancyContextService.runInUserContext(platformOwner.id, (tx) =>
      read(tx),
    );
  }
}
