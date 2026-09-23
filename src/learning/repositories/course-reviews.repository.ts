/**
 * CourseReviewsRepository — read+write for `course_reviews` (P64 Phase 4,
 * master plan §D.4). Every method takes a `Prisma.TransactionClient` and
 * runs under the caller's RLS context (set by `TenancyContextService`),
 * matching every other repository here: a row the caller may not see is
 * simply absent, never an error that reveals its existence. The service
 * layer independently asserts enrollment (author) or reviewer authority
 * (moderation) so a guard failure and an RLS empty-set always agree.
 */
import { Injectable } from '@nestjs/common';
import type { CourseReview, Prisma } from '@prisma/client';
import type { CourseReviewWithStudent } from '../dto/course-review.contract';

const STUDENT_SELECT = {
  student: { select: { id: true, name: true } },
} as const;

@Injectable()
export class CourseReviewsRepository {
  findByStudentAndCourse(
    tx: Prisma.TransactionClient,
    studentId: string,
    courseId: string,
  ): Promise<CourseReviewWithStudent | null> {
    return tx.courseReview.findUnique({
      where: { courseId_studentId: { courseId, studentId } },
      include: STUDENT_SELECT,
    });
  }

  findById(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<CourseReviewWithStudent | null> {
    return tx.courseReview.findUnique({
      where: { id },
      include: STUDENT_SELECT,
    });
  }

  /**
   * Scalar-FK (unchecked) create on purpose: under the author's own RLS
   * context the related `academies`/`courses` rows are not SELECTable by a
   * student, so a nested `connect` would fail its existence probe even
   * though the INSERT itself is allowed by `course_reviews_self_insert`.
   * Writing the foreign keys directly sidesteps that read.
   */
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.CourseReviewUncheckedCreateInput,
  ): Promise<CourseReviewWithStudent> {
    return tx.courseReview.create({ data, include: STUDENT_SELECT });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.CourseReviewUpdateInput,
  ): Promise<CourseReviewWithStudent> {
    return tx.courseReview.update({ where: { id }, data, include: STUDENT_SELECT });
  }

  deleteById(tx: Prisma.TransactionClient, id: string): Promise<CourseReview> {
    return tx.courseReview.delete({ where: { id } });
  }

  /** Moderation list — every status of the course's reviews, newest first. */
  async listByCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
    options: { skip: number; take: number; status?: CourseReview['status'] },
  ): Promise<{ items: CourseReviewWithStudent[]; totalItems: number }> {
    const where: Prisma.CourseReviewWhereInput = {
      courseId,
      ...(options.status ? { status: options.status } : {}),
    };
    const [items, totalItems] = await Promise.all([
      tx.courseReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
        include: STUDENT_SELECT,
      }),
      tx.courseReview.count({ where }),
    ]);
    return { items, totalItems };
  }

  /** Public list — APPROVED reviews only (RLS also enforces this). */
  async listApprovedByCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: CourseReviewWithStudent[]; totalItems: number }> {
    const where: Prisma.CourseReviewWhereInput = { courseId, status: 'approved' };
    const [items, totalItems] = await Promise.all([
      tx.courseReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
        include: STUDENT_SELECT,
      }),
      tx.courseReview.count({ where }),
    ]);
    return { items, totalItems };
  }

  /**
   * Approved ratings for one course, as raw values, so the caller can
   * build the mean and histogram. RLS restricts this to rows the caller
   * may read; for the public path that is exactly the approved set of a
   * published+public course.
   */
  async approvedRatings(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<number[]> {
    const rows = await tx.courseReview.findMany({
      where: { courseId, status: 'approved' },
      select: { rating: true },
    });
    return rows.map((r) => r.rating);
  }
}
