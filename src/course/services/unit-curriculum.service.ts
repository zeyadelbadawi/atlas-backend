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
} from '../dto/curriculum-item.contract';
import type { AttachCurriculumItemDto } from '../dto/attach-curriculum-item.dto';
import type { ReorderItemsDto } from '../dto/reorder-items.dto';
import {
  assertExpectedOrder,
  isExactPermutation,
  lockSectionRow,
  nextUnitOrder,
  persistUnitOrder,
  readUnitItems,
} from './curriculum-ordering';

/** See `CourseCurriculumService.MANAGING_ROLES` — identical rule. */
const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

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
        const items = await readUnitItems(tx, sectionId);
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

        // Serialize appends with concurrent reorders/attaches on this unit.
        await lockSectionRow(tx, sectionId);
        const nextOrder = await nextUnitOrder(tx, sectionId);
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

        const items = await readUnitItems(tx, sectionId);
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

        const items = await readUnitItems(tx, sectionId);
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
   *
   * Concurrency: the section row is locked first, so concurrent reorders of
   * the same unit are serialized and each validates against what the
   * previous one committed. When the client sends `expectedOrderedIds` (the
   * order it was looking at) and the stored order has moved on, the write
   * is refused with 409 `stale_resource_version` — checked before the
   * permutation, because an item added/removed by someone else is a stale
   * view, not a malformed request.
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
        const role = await this.assertCanManage(tx, academyId, userId, courseId);
        const section = await this.assertSectionInCourseInAcademy(
          tx,
          sectionId,
          courseId,
          academyId,
        );
        await lockSectionRow(tx, sectionId);

        const items = await readUnitItems(tx, sectionId);
        const currentIds = items.map((i) => i.id);
        assertExpectedOrder(currentIds, payload.expectedOrderedIds);
        if (!isExactPermutation(currentIds, payload.orderedIds)) {
          throw new BadRequestException({
            messageKey: 'errors.course.invalidReorderSet',
          });
        }
        const byId = new Map(items.map((i) => [i.id, i]));
        await persistUnitOrder(
          tx,
          payload.orderedIds.map((id) => byId.get(id)!),
        );

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course.curriculum.items_reordered',
          targetType: 'course_section',
          targetId: sectionId,
          targetLabel: section.title,
          context: { courseId, sectionId, itemCount: payload.orderedIds.length },
          changes: { order: { from: currentIds, to: [...payload.orderedIds] } },
        });
      },
    );
  }

  // --- internals ----------------------------------------------------------

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
  ): Promise<{ id: string; courseId: string; title: string }> {
    await this.assertCourseInAcademy(tx, courseId, academyId);
    const section = await tx.courseSection.findUnique({
      where: { id: sectionId },
      select: { id: true, courseId: true, title: true },
    });
    if (!section || section.courseId !== courseId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return section;
  }
}
