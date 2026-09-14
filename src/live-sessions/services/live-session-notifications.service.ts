/**
 * Live Session notifications — reusing Atlas's existing fan-out, never a
 * second delivery system.
 *
 * WHAT IS SENT, AND WHAT DELIBERATELY IS NOT. The rule applied throughout
 * is that a notification must tell somebody something they would
 * otherwise miss and can act on:
 *
 *   scheduled  -> yes. A new class appearing in their course is news.
 *   rescheduled-> yes. The time they wrote down is now wrong.
 *   cancelled  -> yes. Turning up to nothing is the worst outcome here.
 *   recording  -> yes, to the HOST. Students are not told, because
 *                 attending a session does not grant access to its
 *                 recording — existing media authorization still decides,
 *                 and announcing a thing somebody may not open is worse
 *                 than silence.
 *   started    -> NO. Students already in the room do not need telling,
 *                 and those who are not are better served by the
 *                 starting-soon reminder than by a second alert.
 *   ended      -> NO. Nobody needs to be notified that a class they just
 *                 attended is over.
 *
 * IN-APP ONLY FOR BULK STUDENT EVENTS. A class of 200 produces 200
 * notifications; sending 200 emails for every reschedule is how a product
 * gets muted. The host's own recording notification does dispatch email,
 * because it is one person and genuinely actionable.
 *
 * `dedupeKey` carries the session and the event, so a retried job or a
 * duplicate provider event cannot notify the same person twice about the
 * same thing.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { NotificationFanoutService } from '../../notification-events/services/notification-fanout.service';

/** The existing `NotificationType` that fits — no new enum member needed. */
const LIVE_SESSION_NOTIFICATION_TYPE = 'activity';

type LiveSessionEvent = 'scheduled' | 'rescheduled' | 'cancelled' | 'starting_soon';

@Injectable()
export class LiveSessionNotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly fanout: NotificationFanoutService,
  ) {}

  /**
   * Tells the students enrolled in this session's course.
   *
   * Called INSIDE the caller's transaction, matching the two-step contract
   * `NotificationFanoutService` documents: the notification row is written
   * with the business change, so a rolled-back reschedule cannot leave
   * students told about a time that never took effect.
   */
  async notifyEnrolledStudents(
    tx: Prisma.TransactionClient,
    args: {
      readonly liveSessionId: string;
      readonly courseId: string;
      readonly academyId: string;
      readonly title: string;
      readonly scheduledStartAt: Date;
      readonly event: LiveSessionEvent;
    },
  ): Promise<void> {
    const enrollments = await tx.enrollment.findMany({
      where: {
        courseId: args.courseId,
        academyId: args.academyId,
        // Only real relationships — the same predicate the join check uses.
        status: { in: ['enrolled', 'completed'] },
      },
      select: { studentId: true },
    });

    for (const enrollment of enrollments) {
      await this.fanout.notify(tx, {
        userId: enrollment.studentId,
        type: LIVE_SESSION_NOTIFICATION_TYPE,
        priority: args.event === 'cancelled' ? 'high' : 'medium',
        titleKey: `notifications:liveSession.${args.event}.title`,
        messageKey: `notifications:liveSession.${args.event}.message`,
        // Values are resolved by the CLIENT's own i18n, which is what
        // keeps a notification correct in whichever language the reader
        // has chosen rather than the language of whoever triggered it.
        values: {
          title: args.title,
          startsAt: args.scheduledStartAt.toISOString(),
        },
        actionUrl: `/dashboard/learning/courses/${args.courseId}`,
        actionLabelKey: 'notifications:liveSession.action.openCourse',
        // One notification per person per session per event, whatever
        // happens to the job that produced it.
        dedupeKey: `live-session:${args.liveSessionId}:${args.event}:${enrollment.studentId}`,
      });
    }
  }

  /**
   * Tells the HOST their recording is ready.
   *
   * Students are deliberately not included: attendance does not grant
   * access to a recording, and existing media authorization is what
   * decides who may open it.
   */
  async notifyRecordingAvailable(
    liveSessionId: string,
    organizationId: string,
  ): Promise<void> {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: liveSessionId },
      select: {
        title: true,
        courseId: true,
        hostUserId: true,
        hostUser: { select: { email: true } },
      },
    });
    if (!session) return;

    const wasNew = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.fanout.notify(tx, {
          userId: session.hostUserId,
          type: LIVE_SESSION_NOTIFICATION_TYPE,
          priority: 'medium',
          titleKey: 'notifications:liveSession.recordingAvailable.title',
          messageKey: 'notifications:liveSession.recordingAvailable.message',
          values: { title: session.title },
          actionUrl: `/dashboard/add-ons/live-sessions/recordings`,
          actionLabelKey: 'notifications:liveSession.action.openRecordings',
          dedupeKey: `live-session:${liveSessionId}:recording-available`,
        }),
    );

    // Step 2, AFTER the transaction above has committed — a failed email
    // must never roll back the notification, per the fan-out contract.
    await this.fanout.sendEmailAfterCommit(session.hostUserId, wasNew, {
      template: 'live_session_recording_available',
      values: { title: session.title },
    });
  }
}
