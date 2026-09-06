/**
 * AssignmentsRepository — read+write for `assignments` as of Phase 4
 * (P24; read-only through P6-P23, see `learning.module.ts`'s doc
 * comment), read+write for `assignment_submissions` (the one
 * student-owned, mutable P6 assignment table). Every method takes a
 * `Prisma.TransactionClient`, matching every other repository in this
 * codebase's established rule.
 */
import { Injectable } from '@nestjs/common';
import type { Assignment, AssignmentSubmission, Prisma } from '@prisma/client';

@Injectable()
export class AssignmentsRepository {
  findManyPublishedForCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<Assignment[]> {
    return tx.assignment.findMany({
      where: { courseId, status: 'published' },
      orderBy: { createdAt: 'asc' },
    });
  }

  findPublishedById(
    tx: Prisma.TransactionClient,
    courseId: string,
    assignmentId: string,
  ): Promise<Assignment | null> {
    return tx.assignment.findFirst({
      where: { id: assignmentId, courseId, status: 'published' },
    });
  }

  findSubmission(
    tx: Prisma.TransactionClient,
    assignmentId: string,
    studentId: string,
  ): Promise<AssignmentSubmission | null> {
    return tx.assignmentSubmission.findUnique({
      where: { assignmentId_studentId: { assignmentId, studentId } },
    });
  }

  createSubmission(
    tx: Prisma.TransactionClient,
    data: Prisma.AssignmentSubmissionCreateInput,
  ): Promise<AssignmentSubmission> {
    return tx.assignmentSubmission.create({ data });
  }

  updateSubmission(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.AssignmentSubmissionUpdateInput,
  ): Promise<AssignmentSubmission> {
    return tx.assignmentSubmission.update({ where: { id }, data });
  }

  // ---------------------------------------------------------------------
  // Phase 4 (P24) — authoring. Reachable only from `AssignmentsService`'s
  // authoring methods, each gated by `assertCanAuthorCourseContent`.
  // ---------------------------------------------------------------------

  /** Every status (draft + published) — the authoring list must show a course's in-progress drafts, unlike `findManyPublishedForCourse`. */
  findManyForCourseAnyStatus(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<Assignment[]> {
    return tx.assignment.findMany({
      where: { courseId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Any status — the authoring counterpart of `findPublishedById`. */
  findAnyById(
    tx: Prisma.TransactionClient,
    courseId: string,
    assignmentId: string,
  ): Promise<Assignment | null> {
    return tx.assignment.findFirst({ where: { id: assignmentId, courseId } });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.AssignmentCreateInput,
  ): Promise<Assignment> {
    return tx.assignment.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.AssignmentUpdateInput,
  ): Promise<Assignment> {
    return tx.assignment.update({ where: { id }, data });
  }

  /** Real SQL DELETE — cascades to `assignment_submissions` (`onDelete: Cascade`, unchanged). Matches `QuizzesRepository.delete`'s identical precedent: no soft-delete state machine exists for an assignment. */
  delete(tx: Prisma.TransactionClient, id: string): Promise<Assignment> {
    return tx.assignment.delete({ where: { id } });
  }
}
