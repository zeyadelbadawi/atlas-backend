/**
 * CourseCurriculumService — sections and lessons: CRUD, plus the
 * move-up/move-down reorder model (`ReorderItemsPayload` — the frontend
 * computes the new full order client-side via `moveItem` and sends the
 * complete `orderedIds` array; this service just persists it, matching
 * master plan P5 §8/§9's explicit "no drag-and-drop backend assumption,
 * just an `order` integer update" instruction).
 *
 * Every ownership-chain verification is explicit (master plan P5 §14):
 * Lesson → Section → Course → Academy → Organization. A caller must never
 * reach a child row by guessing its id under the wrong parent path.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CoursesRepository } from '../repositories/courses.repository';
import { CourseSectionsRepository } from '../repositories/course-sections.repository';
import { CourseLessonsRepository } from '../repositories/course-lessons.repository';
import { toCourseSectionResponse } from '../dto/course-section.contract';
import type { CourseSectionResponse } from '../dto/course-section.contract';
import { toCourseLessonResponse } from '../dto/course-lesson.contract';
import type { CourseLessonResponse } from '../dto/course-lesson.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import type {
  CreateCourseSectionDto,
  UpdateCourseSectionDto,
} from '../dto/course-section.dto';
import type {
  CreateCourseLessonDto,
  UpdateCourseLessonDto,
} from '../dto/course-lesson.dto';
import type { ReorderItemsDto } from '../dto/reorder-items.dto';

/** See `AcademiesService.MANAGING_ROLES` — identical rule. */
const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

@Injectable()
export class CourseCurriculumService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly coursesRepository: CoursesRepository,
    private readonly sectionsRepository: CourseSectionsRepository,
    private readonly lessonsRepository: CourseLessonsRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async getSections(
    courseId: string,
    academyId: string,
    organizationId: string,
  ): Promise<PaginatedResult<CourseSectionResponse>> {
    const sections = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.assertCourseInAcademy(tx, courseId, academyId);
        return this.sectionsRepository.findManyForCourse(tx, courseId);
      },
    );

    const items = sections.map(toCourseSectionResponse);
    return {
      items,
      pagination: buildPaginationMeta(1, Math.max(items.length, 1), items.length),
    };
  }

  async createSection(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: CreateCourseSectionDto,
  ): Promise<CourseSectionResponse> {
    const section = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId);
        await this.assertCourseInAcademy(tx, courseId, academyId);

        const { _max } = await this.sectionsRepository.maxOrder(tx, courseId);
        const created = await this.sectionsRepository.create(tx, {
          course: { connect: { id: courseId } },
          title: payload.title,
          description: payload.description,
          order: (_max.order ?? -1) + 1,
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course_section.created',
          targetType: 'course_section',
          targetId: created.id,
          targetLabel: created.title,
          context: { courseId },
        });

        return created;
      },
    );

    return toCourseSectionResponse({ ...section, lessons: [] });
  }

  async updateSection(
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UpdateCourseSectionDto,
  ): Promise<CourseSectionResponse> {
    const section = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId);
        await this.assertCourseInAcademy(tx, courseId, academyId);
        await this.assertSectionInCourse(tx, sectionId, courseId);

        const updated = await this.sectionsRepository.update(tx, sectionId, {
          title: payload.title,
          description: payload.description,
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course_section.updated',
          targetType: 'course_section',
          targetId: sectionId,
          targetLabel: updated.title,
          context: { courseId },
        });

        return updated;
      },
    );

    const withLessons = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.sectionsRepository.findManyForCourse(tx, courseId),
    );
    const full = withLessons.find((s) => s.id === section.id)!;
    return toCourseSectionResponse(full);
  }

  async deleteSection(
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const role = await this.assertCanManage(tx, academyId, userId);
      await this.assertCourseInAcademy(tx, courseId, academyId);
      const section = await this.assertSectionInCourse(tx, sectionId, courseId);
      // Cascades to `course_lessons` via the FK's `onDelete: Cascade` —
      // matches `CourseService.deleteCourseSection`'s own doc comment:
      // "Deletes a course section and its lessons."
      await this.sectionsRepository.delete(tx, sectionId);

      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'course_section.deleted',
        targetType: 'course_section',
        targetId: sectionId,
        targetLabel: section.title,
        context: { courseId },
      });
    });
  }

  async reorderSections(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: ReorderItemsDto,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      await this.assertCourseInAcademy(tx, courseId, academyId);

      const existing = await this.sectionsRepository.findIdsForCourse(tx, courseId);
      this.assertExactPermutation(
        existing.map((s) => s.id),
        payload.orderedIds,
      );

      await Promise.all(
        payload.orderedIds.map((id, index) =>
          this.sectionsRepository.updateOrder(tx, id, index),
        ),
      );
    });
  }

  async createLesson(
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: CreateCourseLessonDto,
  ): Promise<CourseLessonResponse> {
    const lesson = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId);
        await this.assertCourseInAcademy(tx, courseId, academyId);
        await this.assertSectionInCourse(tx, sectionId, courseId);

        const { _max } = await this.lessonsRepository.maxOrder(tx, sectionId);
        const created = await this.lessonsRepository.create(tx, {
          section: { connect: { id: sectionId } },
          courseId,
          title: payload.title,
          description: payload.description,
          contentType: payload.contentType,
          contentUrl: payload.contentUrl,
          status: payload.status,
          order: (_max.order ?? -1) + 1,
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course_lesson.created',
          targetType: 'course_lesson',
          targetId: created.id,
          targetLabel: created.title,
          context: { courseId, sectionId },
        });

        return created;
      },
    );

    return toCourseLessonResponse(lesson);
  }

  async updateLesson(
    lessonId: string,
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UpdateCourseLessonDto,
  ): Promise<CourseLessonResponse> {
    const lesson = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId);
        await this.assertCourseInAcademy(tx, courseId, academyId);
        await this.assertSectionInCourse(tx, sectionId, courseId);
        await this.assertLessonInSection(tx, lessonId, sectionId);

        const updated = await this.lessonsRepository.update(tx, lessonId, {
          title: payload.title,
          description: payload.description,
          contentType: payload.contentType,
          contentUrl: payload.contentUrl,
          status: payload.status,
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course_lesson.updated',
          targetType: 'course_lesson',
          targetId: lessonId,
          targetLabel: updated.title,
          context: { courseId, sectionId },
        });

        return updated;
      },
    );

    return toCourseLessonResponse(lesson);
  }

  async deleteLesson(
    lessonId: string,
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const role = await this.assertCanManage(tx, academyId, userId);
      await this.assertCourseInAcademy(tx, courseId, academyId);
      await this.assertSectionInCourse(tx, sectionId, courseId);
      const lesson = await this.assertLessonInSection(tx, lessonId, sectionId);
      await this.lessonsRepository.delete(tx, lessonId);

      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'course_lesson.deleted',
        targetType: 'course_lesson',
        targetId: lessonId,
        targetLabel: lesson.title,
        context: { courseId, sectionId },
      });
    });
  }

  async reorderLessons(
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: ReorderItemsDto,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      await this.assertCourseInAcademy(tx, courseId, academyId);
      await this.assertSectionInCourse(tx, sectionId, courseId);

      const existing = await this.lessonsRepository.findIdsForSection(tx, sectionId);
      this.assertExactPermutation(
        existing.map((l) => l.id),
        payload.orderedIds,
      );

      await Promise.all(
        payload.orderedIds.map((id, index) =>
          this.lessonsRepository.updateOrder(tx, id, index),
        ),
      );
    });
  }

  /** Returns the caller's real Academy-membership role (Phase 8) — used as the `role` attributed on each mutation's audit-log entry. */
  private async assertCanManage(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<string> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (!membership || !MANAGING_ROLES.has(membership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.course.insufficientRole' });
    }
    return membership.role;
  }

  private async assertCourseInAcademy(
    tx: Prisma.TransactionClient,
    courseId: string,
    academyId: string,
  ): Promise<void> {
    const course = await this.coursesRepository.findById(tx, courseId);
    if (!course || course.academyId !== academyId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
  }

  /** Returns the section row (Phase 8's `deleteSection` needs its `title` for the audit-log `targetLabel` after the row itself is gone). */
  private async assertSectionInCourse(
    tx: Prisma.TransactionClient,
    sectionId: string,
    courseId: string,
  ): Promise<{ id: string; title: string; courseId: string }> {
    const section = await this.sectionsRepository.findById(tx, sectionId);
    if (!section || section.courseId !== courseId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return section;
  }

  /** Returns the lesson row — see `assertSectionInCourse`'s identical reasoning. */
  private async assertLessonInSection(
    tx: Prisma.TransactionClient,
    lessonId: string,
    sectionId: string,
  ): Promise<{ id: string; title: string; sectionId: string }> {
    const lesson = await this.lessonsRepository.findById(tx, lessonId);
    if (!lesson || lesson.sectionId !== sectionId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return lesson;
  }

  /** `orderedIds` must be exactly the current set of child ids, no more, no fewer — never a partial reorder, never smuggling in a foreign id. */
  private assertExactPermutation(
    existingIds: readonly string[],
    orderedIds: readonly string[],
  ): void {
    const existingSet = new Set(existingIds);
    const orderedSet = new Set(orderedIds);
    const isSameSet =
      existingSet.size === orderedSet.size &&
      [...existingSet].every((id) => orderedSet.has(id));

    if (!isSameSet) {
      throw new BadRequestException({ messageKey: 'errors.course.invalidReorderSet' });
    }
  }
}
