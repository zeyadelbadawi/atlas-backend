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
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CourseProgressRepository } from '../repositories/course-progress.repository';
import { CourseCompletionService } from './course-completion.service';
import { toCourseProgressResponse } from '../dto/course-progress.contract';
import type { CourseProgressResponse } from '../dto/course-progress.contract';
import type { CompleteLessonDto } from '../dto/complete-lesson.dto';
import { assertActiveEnrollment } from './learning-access.util';
import { MINIMUM_WATCHED_RATIO } from '../dto/learning.constants';
import { deriveCompletionState } from './progress-computation.util';

@Injectable()
export class CourseProgressService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly courseCompletionService: CourseCompletionService,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
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
    if (missingLessons.length === 0) {
      // P64 Phase 1 — nothing to backfill for lessons, but the rollup row
      // itself may be missing (an enrollment materialized elsewhere). Never
      // let a read or a completion 500 on that.
      const rollup = await this.courseProgressRepository.findByEnrollmentId(
        tx,
        enrollment.id,
      );
      if (!rollup) {
        const totalLessons = curriculumLessons.length;
        const completedLessons = existingRows.filter(
          (row) => row.status === 'completed',
        ).length;
        const completionState = deriveCompletionState(completedLessons, totalLessons);
        await this.courseProgressRepository.upsertCourseProgress(tx, enrollment.id, {
          totalLessons,
          completedLessons,
          percentage: totalLessons > 0 ? (completedLessons / totalLessons) * 100 : 0,
          currentLessonId:
            existingRows.find((row) => row.status !== 'completed')?.lessonId ?? null,
          completionState,
        });
      }
      return;
    }

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

    await this.courseProgressRepository.upsertCourseProgress(tx, enrollment.id, {
      totalLessons,
      completedLessons,
      percentage: totalLessons > 0 ? (completedLessons / totalLessons) * 100 : 0,
      currentLessonId: currentLesson?.lessonId ?? null,
      completionState,
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
        this.academyStudentsRepository,
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
        this.academyStudentsRepository,
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

      // P64 Phase 2 (§D.6) — the watched-ratio rule.
      //
      // The button stays where it was; what changes is that under
      // `watched_ratio` it refuses below the minimum. The check is on
      // SERVER-CREDITED evidence (`max_watched_ratio`, written only by
      // `PlaybackService` from bounded wall-clock deltas), never on
      // anything this request carries — a client that could assert its own
      // ratio here would make the rule decorative, and a course whose
      // certificate depends on it would be worthless.
      const lesson = await tx.courseLesson.findUnique({
        where: { id: payload.lessonId },
        select: { completionRule: true },
      });
      if (
        lesson?.completionRule === 'watched_ratio' &&
        Number(lessonProgress.maxWatchedRatio) < MINIMUM_WATCHED_RATIO
      ) {
        throw new ForbiddenException({
          messageKey: 'errors.progress.watchRequirementNotMet',
          details: {
            watchedRatio: Number(lessonProgress.maxWatchedRatio),
            requiredRatio: MINIMUM_WATCHED_RATIO,
          },
        });
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
        const currentLesson = allLessonProgress.find((row) => row.status !== 'completed');
        await this.courseProgressRepository.updateCourseProgress(tx, enrollment.id, {
          completedLessons,
          percentage: totalLessons > 0 ? (completedLessons / totalLessons) * 100 : 0,
          currentLessonId: currentLesson?.lessonId ?? null,
        });
        // P64 Phase 3 (AD-11): completion, completedAt, certificate status and the
        // enrollment's completed flag come from the rule evaluator, never from a
        // lesson count alone.
        await this.courseCompletionService.recompute(tx, enrollment);
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

  /**
   * P64 Phase 2 (§D.6/§L) — UNDO a lesson completion.
   *
   * Exists because completion is now something a learner can trigger by
   * accident (an auto-advance, a misclick on a lesson they had not
   * finished), and without an undo their only options were to live with a
   * wrong progress figure or ask staff to fix it. The plan lists it as a
   * first-class endpoint for exactly that reason.
   *
   * WHAT IT DELIBERATELY DOES NOT DO: it does not re-lock the lessons that
   * were unlocked as a consequence. A learner who already saw the next
   * lesson has seen it; taking it back would be a punishment for pressing
   * undo, and re-locking content a person has legitimately reached is a
   * worse outcome than a briefly generous unlock. Only this lesson's own
   * status, the counts and the derived states move.
   *
   * Evidence is NOT reset either. `watched_seconds` and
   * `max_watched_ratio` record what actually happened; erasing them
   * because the learner pressed undo would be rewriting history, and would
   * also let someone under a `watched_ratio` rule clear their own evidence
   * at will.
   */
  async undoCompleteLesson(
    userId: string,
    courseId: string,
    lessonId: string,
  ): Promise<CourseProgressResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const enrollment = await assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
        this.academyStudentsRepository,
      );
      await this.backfillLessonProgress(tx, enrollment, courseId);

      const lessonProgress = await this.courseProgressRepository.findLessonProgress(
        tx,
        enrollment.id,
        lessonId,
      );
      if (!lessonProgress || lessonProgress.courseId !== courseId) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }

      // Idempotent in the same way `completeLesson` is: undoing something
      // that is not complete returns the current state rather than erroring.
      if (lessonProgress.status === 'completed') {
        await this.courseProgressRepository.updateLessonProgress(tx, lessonProgress.id, {
          // Back to `in_progress` when there is evidence of watching, else
          // `available`. Honest either way — it says what the learner
          // actually did.
          status: lessonProgress.watchedSeconds > 0 ? 'in_progress' : 'available',
          completedAt: null,
        });

        const allLessonProgress =
          await this.courseProgressRepository.findLessonProgressForEnrollment(
            tx,
            enrollment.id,
          );
        const totalLessons = allLessonProgress.length;
        const completedLessons = allLessonProgress.filter(
          (row) => row.status === 'completed',
        ).length;
        const currentLesson = allLessonProgress.find((row) => row.status !== 'completed');

        await this.courseProgressRepository.updateCourseProgress(tx, enrollment.id, {
          completedLessons,
          percentage: totalLessons > 0 ? (completedLessons / totalLessons) * 100 : 0,
          currentLessonId: currentLesson?.lessonId ?? null,
        });

        // P64 Phase 3 (AD-11): a course that is no longer complete must not
        // leave the enrollment claiming it is — the evaluator decides, and it
        // never touches an already-issued certificate (D7).
        await this.courseCompletionService.recompute(tx, enrollment);
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
