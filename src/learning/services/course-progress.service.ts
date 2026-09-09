/**
 * CourseProgressService — matches `ProgressService` (atlas frontend)
 * exactly. Progress is computed/updated transactionally within the same
 * request that changes it (master plan §5.3: "on every state change that
 * affects it ... never lazily derived on read") — never a background job.
 *
 * `backfillLessonProgress` (added post-P6): a real, pre-existing gap in
 * the enrollment-materialization model — `LessonProgress` rows are only
 * ever created once, at enrollment time
 * (`EnrollmentsService.createEnrollmentInTransaction`), from whatever
 * published lessons the course had AT THAT MOMENT. A course legitimately
 * gains curriculum after students are already enrolled (an Academy
 * publishing lessons incrementally, the exact scenario that surfaced
 * this), and those students' enrollments were never retroactively
 * backfilled — leaving the new lessons permanently unreachable
 * (`findLessonProgress` returns null → a real 404) with no schema change
 * or security implication, just a missing sync step. Reuses the exact
 * same repository/sequential-unlock rules `createEnrollmentInTransaction`
 * already established rather than inventing a second materialization
 * path; called at the top of both public methods below so every read or
 * write of an enrollment's progress self-heals against the course's
 * CURRENT curriculum before doing anything else.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Enrollment, Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CourseSectionsRepository } from '../../course/repositories/course-sections.repository';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CourseProgressRepository } from '../repositories/course-progress.repository';
import { toCourseProgressResponse } from '../dto/course-progress.contract';
import type { CourseProgressResponse } from '../dto/course-progress.contract';
import type { CompleteLessonDto } from '../dto/complete-lesson.dto';
import { assertActiveEnrollment } from './learning-access.util';
import {
  deriveCertificateStatus,
  deriveCompletionState,
} from './progress-computation.util';

@Injectable()
export class CourseProgressService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly courseProgressRepository: CourseProgressRepository,
    private readonly courseSectionsRepository: CourseSectionsRepository,
  ) {}

  /**
   * Creates any `LessonProgress` rows missing for lessons the course's
   * CURRENT curriculum has but this enrollment's original materialization
   * didn't — preserving curriculum order and the same sequential-unlock
   * rule (`createEnrollmentInTransaction`'s doc comment): a newly-added
   * lesson starts `available` only if every lesson before it (in
   * curriculum order) is already `completed`, otherwise `locked`. A no-op,
   * with no extra writes, when nothing is missing.
   */
  private async backfillLessonProgress(
    tx: Prisma.TransactionClient,
    enrollment: Enrollment,
    courseId: string,
  ): Promise<void> {
    const sections = await this.courseSectionsRepository.findManyForCourse(tx, courseId);
    const curriculumLessons = sections.flatMap((section) =>
      section.lessons
        .filter((lesson) => lesson.status === 'published')
        .map((lesson) => ({ id: lesson.id, sectionId: section.id })),
    );

    const existingRows =
      await this.courseProgressRepository.findLessonProgressForEnrollment(
        tx,
        enrollment.id,
      );
    const existingByLessonId = new Map(existingRows.map((row) => [row.lessonId, row]));
    const missingLessons = curriculumLessons.filter(
      (lesson) => !existingByLessonId.has(lesson.id),
    );
    if (missingLessons.length === 0) return;

    let previousCompleted = true;
    const newRows: Prisma.LessonProgressCreateManyInput[] = [];
    for (const lesson of curriculumLessons) {
      const existing = existingByLessonId.get(lesson.id);
      if (existing) {
        previousCompleted = existing.status === 'completed';
        continue;
      }
      newRows.push({
        enrollmentId: enrollment.id,
        lessonId: lesson.id,
        sectionId: lesson.sectionId,
        courseId,
        status: previousCompleted ? 'available' : 'locked',
      });
      previousCompleted = false;
    }

    await this.courseProgressRepository.createManyLessonProgress(tx, newRows);

    const mergedRows =
      await this.courseProgressRepository.findLessonProgressForEnrollment(
        tx,
        enrollment.id,
      );
    const totalLessons = curriculumLessons.length;
    const completedLessons = mergedRows.filter(
      (row) => row.status === 'completed',
    ).length;
    const completionState = deriveCompletionState(completedLessons, totalLessons);
    const currentLesson = mergedRows.find((row) => row.status !== 'completed');

    await this.courseProgressRepository.updateCourseProgress(tx, enrollment.id, {
      totalLessons,
      completedLessons,
      percentage: totalLessons > 0 ? (completedLessons / totalLessons) * 100 : 0,
      currentLessonId: currentLesson?.lessonId ?? null,
      completionState,
      certificateStatus: deriveCertificateStatus(completionState),
    });
  }

  async getCourseProgress(
    userId: string,
    courseId: string,
  ): Promise<CourseProgressResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const enrollment = await assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
      );
      await this.backfillLessonProgress(tx, enrollment, courseId);
      const courseProgress = await this.courseProgressRepository.findByEnrollmentId(
        tx,
        enrollment.id,
      );
      if (!courseProgress) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const lessonProgressRows =
        await this.courseProgressRepository.findLessonProgressForEnrollment(
          tx,
          enrollment.id,
        );
      return toCourseProgressResponse(courseId, courseProgress, lessonProgressRows);
    });
  }

  async completeLesson(
    userId: string,
    courseId: string,
    payload: CompleteLessonDto,
  ): Promise<CourseProgressResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const enrollment = await assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
      );
      await this.backfillLessonProgress(tx, enrollment, courseId);

      const lessonProgress = await this.courseProgressRepository.findLessonProgress(
        tx,
        enrollment.id,
        payload.lessonId,
      );
      if (!lessonProgress || lessonProgress.courseId !== courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      if (lessonProgress.status === 'locked') {
        throw new ForbiddenException({ messageKey: 'errors.progress.lessonLocked' });
      }

      // Idempotent: completing an already-completed lesson is a no-op
      // that just returns the current state, never an error.
      if (lessonProgress.status !== 'completed') {
        await this.courseProgressRepository.updateLessonProgress(tx, lessonProgress.id, {
          status: 'completed',
          completedAt: new Date(),
        });

        const allLessonProgress =
          await this.courseProgressRepository.findLessonProgressForEnrollment(
            tx,
            enrollment.id,
          );

        // Unlock the next lesson in curriculum order, if any and if it's
        // still locked.
        const completedIndex = allLessonProgress.findIndex(
          (row) => row.lessonId === payload.lessonId,
        );
        const next = allLessonProgress[completedIndex + 1];
        if (next && next.status === 'locked') {
          await this.courseProgressRepository.updateLessonProgress(tx, next.id, {
            status: 'available',
          });
        }

        const totalLessons = allLessonProgress.length;
        const completedLessons = allLessonProgress.filter(
          (row) => row.status === 'completed',
        ).length;
        const completionState = deriveCompletionState(completedLessons, totalLessons);
        const currentLesson = allLessonProgress.find((row) => row.status !== 'completed');

        await this.courseProgressRepository.updateCourseProgress(tx, enrollment.id, {
          completedLessons,
          percentage: totalLessons > 0 ? (completedLessons / totalLessons) * 100 : 0,
          currentLessonId: currentLesson?.lessonId ?? null,
          completionState,
          certificateStatus: deriveCertificateStatus(completionState),
        });

        if (completionState === 'completed' && enrollment.status !== 'completed') {
          await this.enrollmentsRepository.update(tx, enrollment.id, {
            status: 'completed',
            completedAt: new Date(),
          });
        }
      }

      const courseProgress = await this.courseProgressRepository.findByEnrollmentId(
        tx,
        enrollment.id,
      );
      const lessonProgressRows =
        await this.courseProgressRepository.findLessonProgressForEnrollment(
          tx,
          enrollment.id,
        );
      return toCourseProgressResponse(courseId, courseProgress!, lessonProgressRows);
    });
  }
}
