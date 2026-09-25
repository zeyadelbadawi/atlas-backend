/**
 * Expands one published announcement into per-learner notifications, off
 * the request path (cloud remediation, finding F — see
 * `announcement-fanout.types.ts`).
 *
 * CONTEXT. Every batch runs in `runInTenantAndUserContext(organization,
 * publisher)` — the tenant the announcement belongs to plus the user who
 * published it. The publish itself ran in the publisher's user context, so
 * this is never wider than what the request could already see, and the
 * tenant half makes the audience read complete (`enrollments` and
 * `academy_students` both carry `*_tenant_select`).
 *
 * RE-VALIDATED AT EXECUTION TIME. The job is enqueued inside the publish
 * transaction and may start before it commits: an announcement that is
 * not yet visible as THIS publish is retried (thrown), an archived one is
 * dropped. Emission is idempotent per recipient — the catalogue's dedupe
 * key is `announcement.published:<id>` and the in-app row is unique on
 * (user, dedupe key) — so a retried or overlapping job never notifies a
 * learner twice.
 */
import { Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CommunicationService } from '../../communications/services/communication.service';
import {
  ANNOUNCEMENT_FANOUT_BATCH_SIZE,
  AnnouncementFanOutJobPayload,
} from '../queue/announcement-fanout.types';

export class AnnouncementNotYetVisibleError extends Error {}

@Injectable()
export class AnnouncementFanOutService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly communications: CommunicationService,
  ) {}

  /** Returns how many recipients were emitted to (deduped ones included). */
  async run(payload: AnnouncementFanOutJobPayload): Promise<number> {
    const { organizationId, actorUserId, announcementId } = payload;

    const header = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actorUserId,
      async (tx) => {
        const announcement = await tx.announcement.findUnique({
          where: { id: announcementId },
          select: {
            id: true,
            title: true,
            status: true,
            publishedAt: true,
            academyId: true,
          },
        });
        const academy = await tx.academy.findUnique({
          where: { id: payload.academyId },
          select: { name: true },
        });
        const course = payload.courseId
          ? await tx.course.findUnique({
              where: { id: payload.courseId },
              select: { title: true },
            })
          : null;
        return {
          announcement,
          academyName: academy?.name ?? '',
          courseTitle: course?.title ?? '',
        };
      },
    );

    const { announcement } = header;
    if (announcement && announcement.status === 'archived') return 0;
    if (
      !announcement ||
      announcement.academyId !== payload.academyId ||
      announcement.status !== 'published' ||
      announcement.publishedAt?.toISOString() !== payload.publishedAt
    ) {
      // Not (yet) visible as the publish this job was created for — the
      // publish transaction may still be in flight. BullMQ retries with
      // backoff; a publish that rolled back exhausts its attempts harmlessly.
      throw new AnnouncementNotYetVisibleError(
        `Announcement ${announcementId} is not visible as the publish at ${payload.publishedAt}.`,
      );
    }

    let cursor: string | undefined;
    let emitted = 0;
    for (;;) {
      const batch = await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        actorUserId,
        async (tx) => {
          const recipients = await this.nextRecipients(tx, payload, cursor);
          for (const recipientUserId of recipients) {
            await this.communications.emit(tx, {
              key: 'announcement.published',
              recipientUserId,
              academyId: payload.academyId,
              entity: { type: 'announcement', id: announcementId },
              values: {
                title: announcement.title,
                academyName: header.academyName,
                ...(payload.courseId
                  ? { courseId: payload.courseId, courseTitle: header.courseTitle }
                  : {}),
              },
            });
          }
          return recipients;
        },
      );
      emitted += batch.length;
      if (batch.length < ANNOUNCEMENT_FANOUT_BATCH_SIZE) return emitted;
      cursor = batch[batch.length - 1];
    }
  }

  /**
   * One page of the audience, ordered by user id so the cursor is stable.
   * Same predicates the in-request fan-out used: a course announcement
   * reaches enrolled and completed learners; an academy-wide one reaches
   * active, unblocked learners of the academy.
   */
  private async nextRecipients(
    tx: Parameters<Parameters<TenancyContextService['runInUserContext']>[1]>[0],
    payload: AnnouncementFanOutJobPayload,
    cursor: string | undefined,
  ): Promise<string[]> {
    if (payload.courseId) {
      const rows = await tx.enrollment.findMany({
        where: {
          courseId: payload.courseId,
          academyId: payload.academyId,
          status: { in: ['enrolled', 'completed'] },
          ...(cursor ? { studentId: { gt: cursor } } : {}),
        },
        distinct: ['studentId'],
        orderBy: { studentId: 'asc' },
        take: ANNOUNCEMENT_FANOUT_BATCH_SIZE,
        select: { studentId: true },
      });
      return rows.map((row) => row.studentId);
    }
    const rows = await tx.academyStudent.findMany({
      where: {
        academyId: payload.academyId,
        status: 'active',
        blockedAt: null,
        ...(cursor ? { userId: { gt: cursor } } : {}),
      },
      orderBy: { userId: 'asc' },
      take: ANNOUNCEMENT_FANOUT_BATCH_SIZE,
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }
}
