/**
 * CourseInstructorsRepository — the first repository to query
 * `course_instructors` as a primary lookup rather than an embed
 * (`CoursesRepository.findById`'s `instructors` include). Lives in
 * `CourseModule` because `course_instructors` is a Course-owned table
 * (P5); reused by `LearningModule` (P6, extending quiz/assignment read
 * access) and `InstructorModule` (P7) — both already depend on
 * `CourseModule`, never the reverse, matching this codebase's DAG rule.
 *
 * Read-only, matching `course_instructors`'s own P5 precedent (still no
 * write endpoint anywhere — master plan §24's audited decision): this
 * repository only ever resolves teaching scope, never writes it.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

@Injectable()
export class CourseInstructorsRepository {
  isInstructor(
    tx: Prisma.TransactionClient,
    courseId: string,
    userId: string,
  ): Promise<boolean> {
    return tx.courseInstructor
      .findUnique({ where: { courseId_userId: { courseId, userId } } })
      .then((row) => row !== null);
  }

  async findCourseIdsForInstructor(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<string[]> {
    const rows = await tx.courseInstructor.findMany({
      where: { userId },
      select: { courseId: true },
    });
    return rows.map((row) => row.courseId);
  }
}
