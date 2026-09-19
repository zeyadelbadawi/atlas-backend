/**
 * CourseContentService — the student-facing curriculum read path
 * (`GET courses/:id/sections`), added to close a real gap found while
 * wiring the Academy-website-embedded learning experience:
 * `LessonPage`/`CourseLearnRedirectPage` (atlas frontend) previously
 * (mis)reused the instructor/owner-only `academies/:id/courses/:courseId/
 * sections` endpoint (`CourseCurriculumController`, `AcademyScopeGuard`),
 * which requires an `organization_memberships` row — a real, enrolled
 * student never has one, so that call 403'd every genuine student the
 * moment they opened a lesson.
 *
 * Reuses `CourseSectionsRepository.findManyForCourse` verbatim (P5,
 * `CourseModule`, already exported for exactly this kind of reuse — see
 * `LearningModule`'s own doc comment) rather than a second curriculum
 * query. Gated by the same `assertCourseReadAccess` every other P6
 * student-facing read (`QuizzesService.getQuizzes`) already uses — active
 * enrollment OR course instructor, never a bare "any authenticated user."
 * Backed by the additive `course_sections_enrolled_select`/
 * `course_lessons_enrolled_select` RLS policies (P29 migration) — this
 * check and those policies must agree, matching `assertCourseReadAccess`'s
 * own doc comment's discipline for its sibling checks.
 *
 * Unlike the authoring endpoint, this strips `status: 'draft'` lessons
 * from the response — a student must never see a lesson an instructor
 * hasn't published yet, even though RLS itself doesn't distinguish
 * lesson status (a real student is only ever reading their own enrolled
 * course's rows, never another Academy's).
 */
import { Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CourseInstructorsRepository } from '../../course/repositories/course-instructors.repository';
import { CourseSectionsRepository } from '../../course/repositories/course-sections.repository';
import { toCourseSectionResponse } from '../../course/dto/course-section.contract';
import type { CourseSectionResponse } from '../../course/dto/course-section.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { assertCourseReadAccess } from './learning-access.util';

@Injectable()
export class CourseContentService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly courseInstructorsRepository: CourseInstructorsRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly courseSectionsRepository: CourseSectionsRepository,
  ) {}

  async getSections(
    userId: string,
    courseId: string,
  ): Promise<PaginatedResult<CourseSectionResponse>> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCourseReadAccess(
        tx,
        this.enrollmentsRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
        undefined,
        this.academyStudentsRepository,
      );
      const sections = await this.courseSectionsRepository.findManyForCourse(
        tx,
        courseId,
      );

      // The unified, ordered curriculum (P52): published quizzes/assignments
      // are merged with published lessons into ONE per-unit sequence, sorted
      // by the shared unit ordinal. This is the SAME order the author sees;
      // students never receive separate per-type lists. Live sessions are
      // intentionally excluded here — the feature is deferred (Coming Soon),
      // so no customer live-session item is ever surfaced to a student.
      const [quizzes, assignments] = await Promise.all([
        tx.quiz.findMany({
          where: { courseId, status: 'published', sectionId: { not: null } },
          select: { id: true, title: true, order: true, status: true, sectionId: true },
        }),
        tx.assignment.findMany({
          where: { courseId, status: 'published', sectionId: { not: null } },
          select: { id: true, title: true, order: true, status: true, sectionId: true },
        }),
      ]);

      const items = sections.map((section) => {
        const publishedLessons = section.lessons.filter(
          (lesson) => lesson.status === 'published',
        );
        const unified = [
          ...publishedLessons.map((l) => ({
            id: l.id,
            type: 'lesson' as const,
            title: l.title,
            order: l.order,
            status: l.status,
            sectionId: section.id,
          })),
          ...quizzes
            .filter((q) => q.sectionId === section.id)
            .map((q) => ({
              id: q.id,
              type: 'quiz' as const,
              title: q.title,
              order: q.order,
              status: q.status,
              sectionId: section.id,
            })),
          ...assignments
            .filter((a) => a.sectionId === section.id)
            .map((a) => ({
              id: a.id,
              type: 'assignment' as const,
              title: a.title,
              order: a.order,
              status: a.status,
              sectionId: section.id,
            })),
        ].sort(
          (x, y) =>
            x.order - y.order || x.type.localeCompare(y.type) || x.id.localeCompare(y.id),
        );

        return toCourseSectionResponse(
          { ...section, lessons: publishedLessons },
          unified,
        );
      });

      return {
        items,
        pagination: buildPaginationMeta(1, Math.max(items.length, 1), items.length),
      };
    });
  }
}
