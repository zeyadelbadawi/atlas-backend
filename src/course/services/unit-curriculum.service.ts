/**
 * UnitCurriculumService — the unified, ordered curriculum inside a Unit
 * (P52).
 *
 * WHAT THIS IS. A Unit (`course_sections`) composes its existing content —
 * lessons, quizzes, assignments and (future) live sessions — into ONE
 * ordered sequence. There is no polymorphic "activity" table: each type
 * keeps its own entity and identity. The single sequence is expressed by a
 * shared `order` integer space per section that every type participates in
 * (`course_lessons.order`, `quizzes.order`, `assignments.order`,
 * `live_sessions.order`). A "reorder" rewrites that shared ordinal
 * contiguously across whatever types the caller lists.
 *
 * WHY A COMBINED RLS CONTEXT. Section/lesson writes are authorised by the
 * tenant (organization) RLS policies; quiz/assignment writes by the
 * per-user `can_author_course_content` policies. A mixed reorder touches
 * both, so every write here runs inside
 * `runInTenantAndUserContext(organizationId, userId)`, which sets both
 * session variables — neither family of policy is weakened, both are
 * satisfied. The ownership chain (item → section → course → academy) is
 * still verified explicitly in code, exactly as `CourseCurriculumService`
 * does.
 *
 * LIVE SESSIONS STAY DEFERRED. Live sessions are read into the sequence if
 * any exist (so an author would see them in order), but nothing here
 * publishes, enables, installs or otherwise changes Live Sessions or Zoom.
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
import { CourseInstructorsRepository } from '../repositories/course-instructors.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CoursesRepository } from '../repositories/courses.repository';
import type {
  AvailableCurriculumItemResponse,
  CurriculumItemResponse,
  CurriculumItemType,
} from '../dto/curriculum-item.contract';
import type { AttachCurriculumItemDto } from '../dto/attach-curriculum-item.dto';
import type { ReorderItemsDto } from '../dto/reorder-items.dto';

/** See `CourseCurriculumService.MANAGING_ROLES` — identical rule. */
const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

interface ResolvedItem {
  id: string;
  type: CurriculumItemType;
  title: string;
  order: number;
  status: string;
}

@Injectable()
export class UnitCurriculumService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly coursesRepository: CoursesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly courseInstructorsRepository: CourseInstructorsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  /** The unified, ordered curriculum of one unit (author view). */
  async getItems(
    courseId: string,
    sectionId: string,
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<CurriculumItemResponse[]> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId, courseId);
        await this.assertSectionInCourseInAcademy(tx, sectionId, courseId, academyId);
        const items = await this.readSectionItems(tx, sectionId);
        return items.map((item) => ({ ...item, sectionId }));
      },
    );
  }

  /**
   * Course-level quizzes/assignments the author can attach to a unit — the
   * picker's source. Includes items already in another unit (so the picker
   * can show where each one currently lives).
   */
  async getAvailableContent(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<AvailableCurriculumItemResponse[]> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId, courseId);
        await this.assertCourseInAcademy(tx, courseId, academyId);
        const [quizzes, assignments] = await Promise.all([
          tx.quiz.findMany({
            where: { courseId },
            select: { id: true, title: true, status: true, sectionId: true },
            orderBy: { title: 'asc' },
          }),
          tx.assignment.findMany({
            where: { courseId },
            select: { id: true, title: true, status: true, sectionId: true },
            orderBy: { title: 'asc' },
          }),
        ]);
        return [
          ...quizzes.map((q) => ({
            id: q.id,
            type: 'quiz' as const,
            title: q.title,
            status: q.status,
            sectionId: q.sectionId,
          })),
          ...assignments.map((a) => ({
            id: a.id,
            type: 'assignment' as const,
            title: a.title,
            status: a.status,
            sectionId: a.sectionId,
          })),
        ];
      },
    );
  }

  /** Attach an existing course-level quiz/assignment to a unit (append to the end). */
  async attachItem(
    courseId: string,
    sectionId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    dto: AttachCurriculumItemDto,
  ): Promise<CurriculumItemResponse[]> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId, courseId);
        await this.assertSectionInCourseInAcademy(tx, sectionId, courseId, academyId);

        // The item must already belong to THIS course — never reach across
        // courses/academies by guessing an id.
        const existing =
          dto.type === 'quiz'
            ? await tx.quiz.findUnique({
                where: { id: dto.itemId },
                select: { id: true, courseId: true, title: true },
              })
            : await tx.assignment.findUnique({
                where: { id: dto.itemId },
                select: { id: true, courseId: true, title: true },
              });
        if (!existing || existing.courseId !== courseId) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }

        const nextOrder = await this.nextOrder(tx, sectionId);
        if (dto.type === 'quiz') {
          await tx.quiz.update({
            where: { id: dto.itemId },
            data: { sectionId, order: nextOrder },
          });
        } else {
          await tx.assignment.update({
            where: { id: dto.itemId },
            data: { sectionId, order: nextOrder },
          });
        }

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course.curriculum.item_attached',
          targetType: dto.type,
          targetId: dto.itemId,
          targetLabel: existing.title,
          context: { courseId, sectionId },
        });

        const items = await this.readSectionItems(tx, sectionId);
        return items.map((item) => ({ ...item, sectionId }));
      },
    );
  }

  /** Detach a quiz/assignment from its unit (it survives as course-level content). */
  async detachItem(
    courseId: string,
    sectionId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    dto: AttachCurriculumItemDto,
  ): Promise<CurriculumItemResponse[]> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId, courseId);
        await this.assertSectionInCourseInAcademy(tx, sectionId, courseId, academyId);

        const existing =
          dto.type === 'quiz'
            ? await tx.quiz.findUnique({
                where: { id: dto.itemId },
                select: { id: true, courseId: true, sectionId: true, title: true },
              })
            : await tx.assignment.findUnique({
                where: { id: dto.itemId },
                select: { id: true, courseId: true, sectionId: true, title: true },
              });
        if (
          !existing ||
          existing.courseId !== courseId ||
          existing.sectionId !== sectionId
        ) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }

        if (dto.type === 'quiz') {
          await tx.quiz.update({ where: { id: dto.itemId }, data: { sectionId: null } });
        } else {
          await tx.assignment.update({
            where: { id: dto.itemId },
            data: { sectionId: null },
          });
        }

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course.curriculum.item_detached',
          targetType: dto.type,
          targetId: dto.itemId,
          targetLabel: existing.title,
          context: { courseId, sectionId },
        });

        const items = await this.readSectionItems(tx, sectionId);
        return items.map((item) => ({ ...item, sectionId }));
      },
    );
  }

  /**
   * Rewrite the shared unit ordinal from an explicit full ordering. Mirrors
   * the section/lesson reorder model: the client sends the complete
   * `orderedIds` (across types); the server validates it is exactly the
   * current set and writes a contiguous 0..n-1 order onto each item's own
   * table.
   */
  async reorderItems(
    courseId: string,
    sectionId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: ReorderItemsDto,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId, courseId);
        await this.assertSectionInCourseInAcademy(tx, sectionId, courseId, academyId);

        const items = await this.readSectionItems(tx, sectionId);
        this.assertExactPermutation(
          items.map((i) => i.id),
          payload.orderedIds,
        );
        const byId = new Map(items.map((i) => [i.id, i]));

        for (let index = 0; index < payload.orderedIds.length; index += 1) {
          const item = byId.get(payload.orderedIds[index])!;
          await this.writeOrder(tx, item.type, item.id, index);
        }
      },
    );
  }

  // --- internals ----------------------------------------------------------

  /** Merge all content types in a section into one order-sorted list. */
  private async readSectionItems(
    tx: Prisma.TransactionClient,
    sectionId: string,
  ): Promise<ResolvedItem[]> {
    const [lessons, quizzes, assignments, liveSessions] = await Promise.all([
      tx.courseLesson.findMany({
        where: { sectionId },
        select: { id: true, title: true, order: true, status: true },
      }),
      tx.quiz.findMany({
        where: { sectionId },
        select: { id: true, title: true, order: true, status: true },
      }),
      tx.assignment.findMany({
        where: { sectionId },
        select: { id: true, title: true, order: true, status: true },
      }),
      tx.liveSession.findMany({
        where: { sectionId },
        select: { id: true, title: true, order: true, status: true },
      }),
    ]);

    const merged: ResolvedItem[] = [
      ...lessons.map((l) => ({ ...l, type: 'lesson' as const })),
      ...quizzes.map((q) => ({ ...q, type: 'quiz' as const })),
      ...assignments.map((a) => ({ ...a, type: 'assignment' as const })),
      ...liveSessions.map((s) => ({ ...s, type: 'live_session' as const })),
    ];
    // Stable, deterministic: primary by shared order, then type, then id —
    // so ties from legacy data never render in a random order.
    merged.sort(
      (a, b) =>
        a.order - b.order || a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
    );
    return merged;
  }

  private async nextOrder(
    tx: Prisma.TransactionClient,
    sectionId: string,
  ): Promise<number> {
    const items = await this.readSectionItems(tx, sectionId);
    return items.length === 0 ? 0 : Math.max(...items.map((i) => i.order)) + 1;
  }

  private async writeOrder(
    tx: Prisma.TransactionClient,
    type: CurriculumItemType,
    id: string,
    order: number,
  ): Promise<void> {
    switch (type) {
      case 'lesson':
        await tx.courseLesson.update({ where: { id }, data: { order } });
        return;
      case 'quiz':
        await tx.quiz.update({ where: { id }, data: { order } });
        return;
      case 'assignment':
        await tx.assignment.update({ where: { id }, data: { order } });
        return;
      case 'live_session':
        await tx.liveSession.update({ where: { id }, data: { order } });
        return;
    }
  }

  private async assertCanManage(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
    courseId?: string,
  ): Promise<string> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (membership && MANAGING_ROLES.has(membership.role)) {
      return membership.role;
    }
    // P64 Phase 1 (RBAC matrix: "Edit curriculum — Instructor: yes, assigned
    // courses") — the course's own assigned instructor may edit its
    // curriculum; `can_author_course_content()` is the RLS twin.
    if (courseId) {
      const isInstructor = await this.courseInstructorsRepository.isInstructor(
        tx,
        courseId,
        userId,
      );
      if (isInstructor) return 'instructor';
    }
    throw new ForbiddenException({ messageKey: 'errors.course.insufficientRole' });
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

  private async assertSectionInCourseInAcademy(
    tx: Prisma.TransactionClient,
    sectionId: string,
    courseId: string,
    academyId: string,
  ): Promise<void> {
    await this.assertCourseInAcademy(tx, courseId, academyId);
    const section = await tx.courseSection.findUnique({
      where: { id: sectionId },
      select: { id: true, courseId: true },
    });
    if (!section || section.courseId !== courseId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
  }

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
