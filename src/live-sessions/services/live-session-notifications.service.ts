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
import { CommunicationService } from '../../communications/services/communication.service';
import type { EmitResult } from '../../communications/services/communication.service';
import type { CommunicationEventKey } from '../../communications/catalog/communication-catalog';

type LiveSessionEvent = 'scheduled' | 'rescheduled' | 'cancelled' | 'starting_soon';

/** Catalogue key per lifecycle event (P64 Communications). */
const LIVE_SESSION_EVENT_KEYS = {
  scheduled: 'live_session.scheduled',
  rescheduled: 'live_session.rescheduled',
  cancelled: 'live_session.cancelled',
  starting_soon: 'live_session.starting_soon',
} as const satisfies Record<LiveSessionEvent, CommunicationEventKey>;

/*
  Dedupe lives in the catalogue now (`live_session.*` keys): `scheduled`
  and `cancelled` key on the session alone; `rescheduled` and
  `starting_soon` include the announced start instant (`startsAtMs`), so a
  second reschedule is never swallowed while a retried job still collapses.
*/

@Injectable()
export class LiveSessionNotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly communications: CommunicationService,
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

    // Inside the caller's transaction, so no after-commit hint is
    // available here: the one-minute sweep picks these rows up. Values
    // are resolved by the CLIENT's own i18n for the in-app feed; the
    // catalogue keeps these keys in-app only, exactly as before.
    for (const enrollment of enrollments) {
      await this.communications.emit(tx, {
        key: LIVE_SESSION_EVENT_KEYS[args.event],
        recipientUserId: enrollment.studentId,
        academyId: args.academyId,
        entity: { type: 'live_session', id: args.liveSessionId },
        values: {
          title: args.title,
          startsAt: args.scheduledStartAt.toISOString(),
          startsAtMs: args.scheduledStartAt.getTime(),
          courseId: args.courseId,
          studentId: enrollment.studentId,
        },
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

    const emitted: EmitResult = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.communications.emit(tx, {
          key: 'live_session.recording_available',
          recipientUserId: session.hostUserId,
          organizationId,
          entity: { type: 'live_session', id: liveSessionId },
          values: { title: session.title },
        }),
    );

    // Step 2, AFTER the transaction above has committed — a hint to the
    // dispatcher; delivery can never roll back the notification.
    await this.communications.enqueueAfterCommit(emitted.outboxId);
  }
}
