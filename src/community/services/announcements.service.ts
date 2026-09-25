/**
 * AnnouncementsService — matches `AnnouncementService` (atlas frontend)
 * exactly. Reading is always "my visible feed", resolved entirely by RLS
 * (`announcements_platform_select`/`_academy_member_select`/
 * `_course_participant_select`/`_manage_select`, P7 migration) — this
 * service issues the same plain query regardless of who's asking; only
 * authoring is course-scoped, matching the frontend's real, defined
 * contract (no academy- or platform-level write endpoint exists there —
 * see schema.prisma's `Announcement` doc comment).
 *
 * Write authorization mirrors `CoursesService.assertCanManage` exactly
 * (`owner`/`administrator` role in the course's own academy) — the same
 * mechanism the `announcements_manage_*` RLS policies enforce
 * independently; this app-layer check exists to return a real 403 instead
 * of a confusing empty/failed write.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AnnouncementsRepository } from '../repositories/announcements.repository';
import { toAnnouncementResponse } from '../dto/announcement.contract';
import type { AnnouncementResponse } from '../dto/announcement.contract';
import type { CreateAnnouncementDto } from '../dto/create-announcement.dto';
import type { UpdateAnnouncementDto } from '../dto/update-announcement.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { Prisma } from '@prisma/client';
import { CommunicationService } from '../../communications/services/communication.service';

const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

/**
 * Phase 6 — academy-wide announcement authoring, structurally parallel to
 * the pre-existing course-scoped `assertCanManage` above (same
 * `MANAGING_ROLES`, checked against the caller's `academy_members` row
 * directly rather than resolved transitively through a course). Backed by
 * the new `announcements_academy_manage_*` RLS policies (P27 migration) —
 * this app-layer check exists to return a real 403 instead of a
 * confusing empty/failed write, exactly like `assertCanManage`'s own
 * doc comment explains.
 */
async function assertCanManageAcademy(
  tx: Prisma.TransactionClient,
  userId: string,
  academyId: string,
): Promise<void> {
  const membership = await tx.academyMember.findFirst({
    where: { academyId, userId },
  });
  if (!membership || !MANAGING_ROLES.has(membership.role)) {
    throw new ForbiddenException({ messageKey: 'errors.forbidden' });
  }
}

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly announcementsRepository: AnnouncementsRepository,
    private readonly communications: CommunicationService,
  ) {}

  /**
   * P64 Communications C3 (plan §8 H1, §10 "H1 announcement published |
   * audience: yes (type `announcement`) | preference (engagement) with
   * per-announcement 'also email' choice for owners, capped (§22)").
   *
   * THE IN-APP HALF ONLY, and that is a reported gap rather than a
   * decision: `announcements` has no "also email" column, no DTO field
   * and no UI, and this workstream may not add one. The catalogue entry
   * is therefore `email: 'never'` — see its own note for why declaring
   * `preference` instead would have been worse than honest silence.
   *
   * Inside the caller's transaction, exactly like
   * `LiveSessionNotificationsService.notifyEnrolledStudents`: a publish
   * that rolls back must not leave a class told about an announcement
   * they cannot open. No after-commit hint is available from in here;
   * the one-minute sweep is what picks these rows up, and since the
   * catalogue keeps this key in-app only there is nothing to deliver
   * anyway.
   *
   * SIZE. This is a per-recipient loop, so a course announcement costs
   * one emit per enrolment and an ACADEMY-wide one costs one per active
   * learner. That is the same exposure the live-session fan-out already
   * carries, and it is bounded by the in-app channel — but §21's
   * "announcement emails are SIZED before enqueue" has no counterpart
   * here, and would need one before the email half ships.
   */
  private async fanOutPublished(
    tx: Prisma.TransactionClient,
    announcement: {
      readonly id: string;
      readonly title: string;
      readonly academyId: string;
      readonly courseId: string | null;
    },
  ): Promise<void> {
    const academy = await tx.academy.findUnique({
      where: { id: announcement.academyId },
      select: { name: true },
    });

    let recipientIds: string[];
    let courseTitle = '';
    if (announcement.courseId) {
      const course = await tx.course.findUnique({
        where: { id: announcement.courseId },
        select: { title: true },
      });
      courseTitle = course?.title ?? '';
      const enrollments = await tx.enrollment.findMany({
        where: {
          courseId: announcement.courseId,
          academyId: announcement.academyId,
          // The same predicate the live-session fan-out uses: only real
          // relationships, and a learner who finished the course is still
          // party to an announcement about it.
          status: { in: ['enrolled', 'completed'] },
        },
        select: { studentId: true },
      });
      recipientIds = enrollments.map((row) => row.studentId);
    } else {
      // Academy-wide: the learners who can actually reach the academy —
      // a pending applicant or a blocked learner is not an audience.
      const students = await tx.academyStudent.findMany({
        where: { academyId: announcement.academyId, status: 'active', blockedAt: null },
        select: { userId: true },
      });
      recipientIds = students.map((row) => row.userId);
    }

    for (const recipientUserId of new Set(recipientIds)) {
      await this.communications.emit(tx, {
        key: 'announcement.published',
        recipientUserId,
        academyId: announcement.academyId,
        entity: { type: 'announcement', id: announcement.id },
        values: {
          title: announcement.title,
          academyName: academy?.name ?? '',
          ...(announcement.courseId
            ? { courseId: announcement.courseId, courseTitle }
            : {}),
        },
      });
    }
  }

  private async assertCanManage(
    tx: Prisma.TransactionClient,
    userId: string,
    courseId: string,
  ): Promise<{ academyId: string }> {
    const course = await tx.course.findUnique({
      where: { id: courseId },
      select: { id: true, academyId: true },
    });
    if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });

    const membership = await tx.academyMember.findFirst({
      where: { academyId: course.academyId, userId },
    });
    if (!membership || !MANAGING_ROLES.has(membership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.forbidden' });
    }
    return { academyId: course.academyId };
  }

  async getFeed(
    userId: string,
    query?: CollectionQueryDto,
  ): Promise<PaginatedResult<AnnouncementResponse>> {
    const page = query?.page ?? DEFAULT_PAGE;
    const pageSize = query?.pageSize ?? DEFAULT_PAGE_SIZE;
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const { items, totalItems } = await this.announcementsRepository.findFeed(tx, {
        skip: (page - 1) * pageSize,
        take: pageSize,
      });
      return {
        items: items.map((a) => toAnnouncementResponse(a, a.author.name)),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  async getAnnouncement(userId: string, id: string): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const announcement = await this.announcementsRepository.findById(tx, id);
      if (!announcement) throw new NotFoundException({ messageKey: 'errors.notFound' });
      return toAnnouncementResponse(announcement, announcement.author.name);
    });
  }

  async getCourseAnnouncements(
    userId: string,
    courseId: string,
    query?: CollectionQueryDto,
  ): Promise<PaginatedResult<AnnouncementResponse>> {
    const page = query?.page ?? DEFAULT_PAGE;
    const pageSize = query?.pageSize ?? DEFAULT_PAGE_SIZE;
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertCanManage(tx, userId, courseId);
      const { items, totalItems } = await this.announcementsRepository.findManyForCourse(
        tx,
        courseId,
        { skip: (page - 1) * pageSize, take: pageSize },
      );
      return {
        items: items.map((a) => toAnnouncementResponse(a, a.author.name)),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  async createAnnouncement(
    userId: string,
    courseId: string,
    payload: CreateAnnouncementDto,
  ): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const { academyId } = await this.assertCanManage(tx, userId, courseId);
      const created = await this.announcementsRepository.create(tx, {
        audience: 'course',
        academy: { connect: { id: academyId } },
        course: { connect: { id: courseId } },
        author: { connect: { id: userId } },
        title: payload.title,
        body: payload.body,
        scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : undefined,
        status: payload.scheduledAt ? 'scheduled' : 'draft',
      });
      return toAnnouncementResponse(created, created.author.name);
    });
  }

  async updateAnnouncement(
    userId: string,
    courseId: string,
    announcementId: string,
    payload: UpdateAnnouncementDto,
  ): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertCanManage(tx, userId, courseId);
      const existing = await this.announcementsRepository.findById(tx, announcementId);
      if (!existing || existing.courseId !== courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const updated = await this.announcementsRepository.update(tx, announcementId, {
        title: payload.title,
        body: payload.body,
        scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : undefined,
      });
      return toAnnouncementResponse(updated, updated.author.name);
    });
  }

  async publishAnnouncement(
    userId: string,
    courseId: string,
    announcementId: string,
  ): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const { academyId } = await this.assertCanManage(tx, userId, courseId);
      const existing = await this.announcementsRepository.findById(tx, announcementId);
      if (!existing || existing.courseId !== courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const alreadyPublished = existing.status === 'published';
      const updated = await this.announcementsRepository.update(tx, announcementId, {
        status: 'published',
        publishedAt: new Date(),
      });
      // Only the TRANSITION is news. Re-publishing an already-published
      // announcement (this endpoint is not idempotent about
      // `publishedAt`) must not fan out a second time — the catalogue's
      // dedupe key would swallow it, but only after a row and a savepoint
      // per learner.
      if (!alreadyPublished) {
        await this.fanOutPublished(tx, {
          id: updated.id,
          title: updated.title,
          academyId,
          courseId,
        });
      }
      return toAnnouncementResponse(updated, updated.author.name);
    });
  }

  async archiveAnnouncement(
    userId: string,
    courseId: string,
    announcementId: string,
  ): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await this.assertCanManage(tx, userId, courseId);
      const existing = await this.announcementsRepository.findById(tx, announcementId);
      if (!existing || existing.courseId !== courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const updated = await this.announcementsRepository.update(tx, announcementId, {
        status: 'archived',
      });
      return toAnnouncementResponse(updated, updated.author.name);
    });
  }

  // ---------------------------------------------------------------------
  // Phase 6 — academy-wide authoring. Mirrors the course-scoped methods
  // above exactly (same shape, same lifecycle), scoped to an Academy
  // directly instead of transitively through a Course.
  // ---------------------------------------------------------------------

  async getAcademyAnnouncements(
    userId: string,
    academyId: string,
    query?: CollectionQueryDto,
  ): Promise<PaginatedResult<AnnouncementResponse>> {
    const page = query?.page ?? DEFAULT_PAGE;
    const pageSize = query?.pageSize ?? DEFAULT_PAGE_SIZE;
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCanManageAcademy(tx, userId, academyId);
      const { items, totalItems } = await this.announcementsRepository.findManyForAcademy(
        tx,
        academyId,
        { skip: (page - 1) * pageSize, take: pageSize },
      );
      return {
        items: items.map((a) => toAnnouncementResponse(a, a.author.name)),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  async createAcademyAnnouncement(
    userId: string,
    academyId: string,
    payload: CreateAnnouncementDto,
  ): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCanManageAcademy(tx, userId, academyId);
      const created = await this.announcementsRepository.create(tx, {
        audience: 'academy',
        academy: { connect: { id: academyId } },
        author: { connect: { id: userId } },
        title: payload.title,
        body: payload.body,
        scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : undefined,
        status: payload.scheduledAt ? 'scheduled' : 'draft',
      });
      return toAnnouncementResponse(created, created.author.name);
    });
  }

  async updateAcademyAnnouncement(
    userId: string,
    academyId: string,
    announcementId: string,
    payload: UpdateAnnouncementDto,
  ): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCanManageAcademy(tx, userId, academyId);
      const existing = await this.announcementsRepository.findById(tx, announcementId);
      if (!existing || existing.academyId !== academyId || existing.courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const updated = await this.announcementsRepository.update(tx, announcementId, {
        title: payload.title,
        body: payload.body,
        scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : undefined,
      });
      return toAnnouncementResponse(updated, updated.author.name);
    });
  }

  async publishAcademyAnnouncement(
    userId: string,
    academyId: string,
    announcementId: string,
  ): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCanManageAcademy(tx, userId, academyId);
      const existing = await this.announcementsRepository.findById(tx, announcementId);
      if (!existing || existing.academyId !== academyId || existing.courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const alreadyPublished = existing.status === 'published';
      const updated = await this.announcementsRepository.update(tx, announcementId, {
        status: 'published',
        publishedAt: new Date(),
      });
      if (!alreadyPublished) {
        await this.fanOutPublished(tx, {
          id: updated.id,
          title: updated.title,
          academyId,
          courseId: null,
        });
      }
      return toAnnouncementResponse(updated, updated.author.name);
    });
  }

  async archiveAcademyAnnouncement(
    userId: string,
    academyId: string,
    announcementId: string,
  ): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCanManageAcademy(tx, userId, academyId);
      const existing = await this.announcementsRepository.findById(tx, announcementId);
      if (!existing || existing.academyId !== academyId || existing.courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const updated = await this.announcementsRepository.update(tx, announcementId, {
        status: 'archived',
      });
      return toAnnouncementResponse(updated, updated.author.name);
    });
  }

  // ---------------------------------------------------------------------
  // Phase 6 — platform-wide authoring. Authorization is the controller's
  // `PlatformOwnerGuard` (re-checked live against `users.is_platform_owner`
  // on every call, never a JWT claim — matching every other Platform-Owner
  // surface in this codebase); the `announcements_platform_manage_*` RLS
  // policies (P27 migration) are the backstop, not the primary gate,
  // mirroring `assertCanManage`'s own "app-layer check exists to return a
  // real error, RLS is the independent third layer" doc comment.
  // ---------------------------------------------------------------------

  async getPlatformAnnouncements(
    userId: string,
    query?: CollectionQueryDto,
  ): Promise<PaginatedResult<AnnouncementResponse>> {
    const page = query?.page ?? DEFAULT_PAGE;
    const pageSize = query?.pageSize ?? DEFAULT_PAGE_SIZE;
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const { items, totalItems } =
        await this.announcementsRepository.findManyForPlatform(tx, {
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
      return {
        items: items.map((a) => toAnnouncementResponse(a, a.author.name)),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  async createPlatformAnnouncement(
    userId: string,
    payload: CreateAnnouncementDto,
  ): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const created = await this.announcementsRepository.create(tx, {
        audience: 'platform',
        author: { connect: { id: userId } },
        title: payload.title,
        body: payload.body,
        scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : undefined,
        status: payload.scheduledAt ? 'scheduled' : 'draft',
      });
      return toAnnouncementResponse(created, created.author.name);
    });
  }

  async updatePlatformAnnouncement(
    userId: string,
    announcementId: string,
    payload: UpdateAnnouncementDto,
  ): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const existing = await this.announcementsRepository.findById(tx, announcementId);
      if (!existing || existing.audience !== 'platform') {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const updated = await this.announcementsRepository.update(tx, announcementId, {
        title: payload.title,
        body: payload.body,
        scheduledAt: payload.scheduledAt ? new Date(payload.scheduledAt) : undefined,
      });
      return toAnnouncementResponse(updated, updated.author.name);
    });
  }

  /**
   * P64 Communications C3 — DELIBERATELY NOT FANNED OUT.
   *
   * A platform announcement's audience is "every user of Atlas", and
   * `announcements_platform_select` already makes it visible to all of
   * them in the announcements feed with no notification row at all.
   * Writing one `notifications` + `communication_outbox` pair per account
   * inside the Platform Owner's publish transaction would make one click
   * an unbounded write, and §21's "size the audience before you enqueue"
   * has nothing to size it with. Recipient resolution here needs the same
   * design decision the staff/platform digests are waiting on (MR-4).
   */
  async publishPlatformAnnouncement(
    userId: string,
    announcementId: string,
  ): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const existing = await this.announcementsRepository.findById(tx, announcementId);
      if (!existing || existing.audience !== 'platform') {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const updated = await this.announcementsRepository.update(tx, announcementId, {
        status: 'published',
        publishedAt: new Date(),
      });
      return toAnnouncementResponse(updated, updated.author.name);
    });
  }

  async archivePlatformAnnouncement(
    userId: string,
    announcementId: string,
  ): Promise<AnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const existing = await this.announcementsRepository.findById(tx, announcementId);
      if (!existing || existing.audience !== 'platform') {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const updated = await this.announcementsRepository.update(tx, announcementId, {
        status: 'archived',
      });
      return toAnnouncementResponse(updated, updated.author.name);
    });
  }
}
