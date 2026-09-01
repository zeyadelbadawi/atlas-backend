/**
 * EnrollmentsRepository — every method takes a `Prisma.TransactionClient`
 * obtained from `TenancyContextService`, never the raw `PrismaService`,
 * matching every other repository in this codebase's established rule.
 */
import { Injectable } from '@nestjs/common';
import type {
  Course,
  CourseCategory,
  CourseInstructor,
  Enrollment,
  Prisma,
  User,
} from '@prisma/client';

/** Row shape returned by {@link EnrollmentsRepository.findManyForStudent} — an `Enrollment` with its `course` (and the course's `category`/`instructors`) joined in, matching what `toEnrollmentResponse` needs to build a "My Learning" card. */
export type EnrollmentWithCourse = Enrollment & {
  course: Course & {
    category: CourseCategory | null;
    instructors: (CourseInstructor & { user: Pick<User, 'id' | 'name' | 'avatarUrl'> })[];
  };
};

@Injectable()
export class EnrollmentsRepository {
  findByStudentAndCourse(
    tx: Prisma.TransactionClient,
    studentId: string,
    courseId: string,
  ): Promise<Enrollment | null> {
    return tx.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
    });
  }

  findById(tx: Prisma.TransactionClient, id: string): Promise<Enrollment | null> {
    return tx.enrollment.findUnique({ where: { id } });
  }

  async findManyForStudent(
    tx: Prisma.TransactionClient,
    studentId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: EnrollmentWithCourse[]; totalItems: number }> {
    const where: Prisma.EnrollmentWhereInput = { studentId };
    const [items, totalItems] = await Promise.all([
      tx.enrollment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
        // Joined so `EnrollmentsService.list` can return enough per-row
        // course detail (title/thumbnail/pricing) to render a "My
        // Learning" card grid without a second round-trip per row — see
        // `EnrollmentResponse.course`'s doc comment for why this join
        // exists only here, not on the other lookup methods below.
        include: {
          course: {
            include: {
              category: true,
              instructors: {
                include: { user: { select: { id: true, name: true, avatarUrl: true } } },
              },
            },
          },
        },
      }),
      tx.enrollment.count({ where }),
    ]);
    return { items, totalItems };
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.EnrollmentCreateInput,
  ): Promise<Enrollment> {
    return tx.enrollment.create({ data });
  }

  /**
   * Phase 2 — whether this student already holds at least one OTHER real
   * (non-`unavailable`) enrollment anywhere in this organization, BEFORE
   * the enrollment currently being created. `EnrollmentsService.
   * createEnrollment` uses this to decide whether a new enrollment
   * actually adds a NEW distinct student against the `students` plan
   * limit (0 more, if they are already counted via another course in the
   * same organization) or a genuinely new one (1 more) — without this,
   * a student's second, third, ... enrollment in the same organization
   * would be wrongly charged against the limit a second time, a real
   * false-positive block the roadmap explicitly requires this codebase
   * avoid ("confirm no false-positive blocking").
   */
  countActiveForStudentInOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
    studentId: string,
  ): Promise<number> {
    return tx.enrollment.count({
      where: {
        studentId,
        status: { not: 'unavailable' },
        course: { academy: { organizationId, status: { not: 'archived' } } },
      },
    });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.EnrollmentUpdateInput,
  ): Promise<Enrollment> {
    return tx.enrollment.update({ where: { id }, data });
  }
}
