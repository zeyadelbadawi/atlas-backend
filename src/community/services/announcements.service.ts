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

const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly announcementsRepository: AnnouncementsRepository,
  ) {}

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
      await this.assertCanManage(tx, userId, courseId);
      const existing = await this.announcementsRepository.findById(tx, announcementId);
      if (!existing || existing.courseId !== courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      const updated = await this.announcementsRepository.update(tx, announcementId, {
        status: 'published',
        publishedAt: new Date(),
      });
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
}
