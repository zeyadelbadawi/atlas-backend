/**
 * CourseOrdersRepository — every method takes a `Prisma.TransactionClient`
 * obtained from `TenancyContextService`, never the raw `PrismaService`,
 * matching every other repository in this codebase's established rule.
 * `course_orders` is student-scoped (`app.current_user_id`), same
 * mechanism as `EnrollmentsRepository` — see this table's RLS policies
 * (migration.sql) for the full reasoning.
 */
import { Injectable } from '@nestjs/common';
import type { CourseOrder, Prisma } from '@prisma/client';

@Injectable()
export class CourseOrdersRepository {
  findById(tx: Prisma.TransactionClient, id: string): Promise<CourseOrder | null> {
    return tx.courseOrder.findUnique({ where: { id } });
  }

  /** Scoped defensively to the caller's own student id, even though RLS already enforces it — matches every other repository's "RLS is never the only check" rule. */
  findByIdForStudent(
    tx: Prisma.TransactionClient,
    studentId: string,
    id: string,
  ): Promise<CourseOrder | null> {
    return tx.courseOrder.findFirst({ where: { id, studentId } });
  }

  findByIdempotencyKey(
    tx: Prisma.TransactionClient,
    studentId: string,
    idempotencyKey: string,
  ): Promise<CourseOrder | null> {
    return tx.courseOrder.findUnique({
      where: { studentId_idempotencyKey: { studentId, idempotencyKey } },
    });
  }

  /** Any non-terminal order for this student+course — used to reject creating a second concurrent order for a course the student is already mid-purchase on. */
  findActiveForStudentAndCourse(
    tx: Prisma.TransactionClient,
    studentId: string,
    courseId: string,
  ): Promise<CourseOrder | null> {
    return tx.courseOrder.findFirst({
      where: { studentId, courseId, status: { in: ['draft', 'pending_payment'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findManyForStudent(
    tx: Prisma.TransactionClient,
    studentId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: CourseOrder[]; totalItems: number }> {
    const where: Prisma.CourseOrderWhereInput = { studentId };
    const [items, totalItems] = await Promise.all([
      tx.courseOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      tx.courseOrder.count({ where }),
    ]);
    return { items, totalItems };
  }

  /**
   * `UncheckedCreateInput` (plain scalar FKs — `studentId`/`courseId`/
   * `academyId`/`organizationId`), not the relational `CreateInput` —
   * deliberately. The relational form's nested `connect` performs its own
   * pre-flight existence SELECT on the referenced tables under the
   * caller's active session context; a buying student is never an
   * organization/academy member, so `academies`/`organizations`' RLS
   * makes those rows genuinely invisible to that SELECT even though they
   * exist — a false "not found." The plain FK write skips that check
   * entirely and lets Postgres's own foreign-key constraint (which, per
   * Postgres's documented semantics, always bypasses row security to
   * preserve referential integrity) be the real validation — matches
   * `EnrollmentsRepository.create`'s identical existing precedent for
   * `Enrollment.academyId`.
   */
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.CourseOrderUncheckedCreateInput,
  ): Promise<CourseOrder> {
    return tx.courseOrder.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.CourseOrderUpdateInput,
  ): Promise<CourseOrder> {
    return tx.courseOrder.update({ where: { id }, data });
  }
}
