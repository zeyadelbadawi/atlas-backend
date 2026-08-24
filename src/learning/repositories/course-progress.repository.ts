/**
 * CourseProgressRepository — owns both `course_progress` (1:1 per
 * enrollment) and `lesson_progress` (materialized one row per published
 * lesson at enrollment time — see `EnrollmentsService.createEnrollment`).
 * Every method takes a `Prisma.TransactionClient`, matching every other
 * repository in this codebase's established rule.
 */
import { Injectable } from '@nestjs/common';
import type { CourseProgress, LessonProgress, Prisma } from '@prisma/client';

type LessonProgressWithOrder = LessonProgress & {
  lesson: { order: number; section: { order: number } };
};

@Injectable()
export class CourseProgressRepository {
  createCourseProgress(
    tx: Prisma.TransactionClient,
    data: Prisma.CourseProgressCreateInput,
  ): Promise<CourseProgress> {
    return tx.courseProgress.create({ data });
  }

  findByEnrollmentId(
    tx: Prisma.TransactionClient,
    enrollmentId: string,
  ): Promise<CourseProgress | null> {
    return tx.courseProgress.findUnique({ where: { enrollmentId } });
  }

  updateCourseProgress(
    tx: Prisma.TransactionClient,
    enrollmentId: string,
    data: Prisma.CourseProgressUpdateInput,
  ): Promise<CourseProgress> {
    return tx.courseProgress.update({ where: { enrollmentId }, data });
  }

  createManyLessonProgress(
    tx: Prisma.TransactionClient,
    rows: Prisma.LessonProgressCreateManyInput[],
  ): Promise<Prisma.BatchPayload> {
    return tx.lessonProgress.createMany({ data: rows });
  }

  /** Ordered by curriculum position (section order, then lesson order within it) — never by id/creation order, which carries no curriculum meaning. */
  async findLessonProgressForEnrollment(
    tx: Prisma.TransactionClient,
    enrollmentId: string,
  ): Promise<LessonProgress[]> {
    const rows = (await tx.lessonProgress.findMany({
      where: { enrollmentId },
      include: {
        lesson: { select: { order: true, section: { select: { order: true } } } },
      },
    })) as LessonProgressWithOrder[];

    return rows
      .sort((a, b) => {
        const sectionDelta = a.lesson.section.order - b.lesson.section.order;
        return sectionDelta !== 0 ? sectionDelta : a.lesson.order - b.lesson.order;
      })
      .map(({ lesson: _lesson, ...row }) => row as LessonProgress);
  }

  findLessonProgress(
    tx: Prisma.TransactionClient,
    enrollmentId: string,
    lessonId: string,
  ): Promise<LessonProgress | null> {
    return tx.lessonProgress.findUnique({
      where: { enrollmentId_lessonId: { enrollmentId, lessonId } },
    });
  }

  updateLessonProgress(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.LessonProgressUpdateInput,
  ): Promise<LessonProgress> {
    return tx.lessonProgress.update({ where: { id }, data });
  }
}
