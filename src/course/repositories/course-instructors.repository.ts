/**
 * CourseInstructorsRepository — the first repository to query
 * `course_instructors` as a primary lookup rather than an embed
 * (`CoursesRepository.findById`'s `instructors` include). Lives in
 * `CourseModule` because `course_instructors` is a Course-owned table
 * (P5); reused by `LearningModule` (P6, extending quiz/assignment read
 * access) and `InstructorModule` (P7) — both already depend on
 * `CourseModule`, never the reverse, matching this codebase's DAG rule.
 *
 * Phase 3 (master plan §22/§23) adds the first write operations
 * (`create`/`delete`) — `CoursesService.assignInstructor`/
 * `removeInstructor` are the only callers. No ordering/rank column exists
 * on the row and none is added: every assigned instructor has identical
 * standing (no primary/lead/secondary concept — see `CoursesService`'s
 * doc comment on `assignInstructor`).
 */
import { Injectable } from '@nestjs/common';
import type { CourseInstructor, Prisma } from '@prisma/client';

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

  /** Grants course-level instructor access. Caller (`CoursesService.assignInstructor`) has already verified eligibility (an active Academy `instructor` membership in the course's own academy) and that no row already exists — this is a plain insert, never an upsert, so a genuine race still surfaces as a real unique-constraint conflict rather than being silently swallowed. */
  create(
    tx: Prisma.TransactionClient,
    courseId: string,
    userId: string,
  ): Promise<CourseInstructor> {
    return tx.courseInstructor.create({ data: { courseId, userId } });
  }

  /** Revokes course-level instructor access. Caller has already verified the row exists — mirrors `CourseSectionsRepository.delete`'s plain `.delete({ where: { id } })` precedent, just keyed by the table's own composite PK. */
  delete(
    tx: Prisma.TransactionClient,
    courseId: string,
    userId: string,
  ): Promise<CourseInstructor> {
    return tx.courseInstructor.delete({ where: { courseId_userId: { courseId, userId } } });
  }
}
