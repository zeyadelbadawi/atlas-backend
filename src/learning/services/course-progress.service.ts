/**
 * CourseProgressService — matches `ProgressService` (atlas frontend)
 * exactly. Progress is computed/updated transactionally within the same
 * request that changes it (master plan §5.3: "on every state change that
 * affects it ... never lazily derived on read") — never a background job.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
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
  ) {}

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
