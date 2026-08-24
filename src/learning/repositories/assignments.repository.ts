/**
 * AssignmentsRepository — read-only for `assignments` (no write endpoint
 * in P6, see `learning.module.ts`'s doc comment), read+write for
 * `assignment_submissions` (the one student-owned, mutable P6 assignment
 * table). Every method takes a `Prisma.TransactionClient`, matching every
 * other repository in this codebase's established rule.
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
}
