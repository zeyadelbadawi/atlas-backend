/**
 * AcademyRosterRepository — P64 Phase 1 (Finding F4).
 *
 * The first reader of `academy_students` as a ROSTER. Every method takes an
 * already-open transaction and is meaningful only under
 * `runInTenantAndUserContext` (tenant SELECT on `academy_students` and
 * `enrollments`; `academy_students_staff_select` narrows an instructor to
 * the students of courses they teach — see `can_view_academy_student()`).
 * The service applies the same rule in the application layer first.
 */
import { Injectable } from '@nestjs/common';
import type {
  AcademyStudent,
  AssignmentSubmission,
  CourseProgress,
  Enrollment,
  Prisma,
  QuizAttempt,
  User,
} from '@prisma/client';

export type RosterStudentRow = AcademyStudent & {
  user: Pick<User, 'id' | 'name' | 'email' | 'avatarUrl' | 'status' | 'emailVerifiedAt'>;
  enrollmentCount: number;
  activeEnrollmentCount: number;
};

export interface RosterQuery {
  readonly search?: string;
  readonly status?: 'active' | 'inactive' | 'pending' | 'blocked';
  readonly courseId?: string;
  readonly sortBy: 'joinedAt' | 'lastActivityAt' | 'name';
  readonly sortDir: 'asc' | 'desc';
  readonly skip: number;
  readonly take: number;
  /** Instructor scope: only students enrolled in one of these courses. `undefined` = whole academy. */
  readonly restrictToCourseIds?: readonly string[];
}

export type RosterEnrollmentRow = Enrollment & {
  course: { id: string; title: string; slug: string; status: string };
  progress: CourseProgress | null;
};

@Injectable()
export class AcademyRosterRepository {
  private buildWhere(
    academyId: string,
    query: RosterQuery,
  ): Prisma.AcademyStudentWhereInput {
    const where: Prisma.AcademyStudentWhereInput = { academyId };
    const userFilter: Prisma.UserWhereInput = {};
    if (query.search) {
      userFilter.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.status === 'blocked') {
      where.blockedAt = { not: null };
    } else if (query.status) {
      where.status = query.status;
      where.blockedAt = null;
    }
    let courseScope: string[] | null = null;
    if (query.restrictToCourseIds) {
      const allowed = new Set(query.restrictToCourseIds);
      courseScope = query.courseId
        ? allowed.has(query.courseId)
          ? [query.courseId]
          : []
        : [...allowed];
      if (courseScope.length === 0) courseScope = ['__none__'];
    } else if (query.courseId) {
      courseScope = [query.courseId];
    }
    if (courseScope) {
      userFilter.enrollments = { some: { academyId, courseId: { in: courseScope } } };
    }
    if (Object.keys(userFilter).length > 0) where.user = userFilter;
    return where;
  }

  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    query: RosterQuery,
  ): Promise<{ items: RosterStudentRow[]; totalItems: number }> {
    const where = this.buildWhere(academyId, query);
    const orderBy: Prisma.AcademyStudentOrderByWithRelationInput =
      query.sortBy === 'name'
        ? { user: { name: query.sortDir } }
        : query.sortBy === 'lastActivityAt'
          ? { lastActivityAt: { sort: query.sortDir, nulls: 'last' } }
          : { joinedAt: query.sortDir };

    const [rows, totalItems] = await Promise.all([
      tx.academyStudent.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.take,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              avatarUrl: true,
              status: true,
              emailVerifiedAt: true,
            },
          },
        },
      }),
      tx.academyStudent.count({ where }),
    ]);

    const userIds = rows.map((row) => row.userId);
    const counts = userIds.length
      ? await tx.enrollment.groupBy({
          by: ['studentId'],
          where: { academyId, studentId: { in: userIds } },
          _count: { _all: true },
        })
      : [];
    // "Active" here must mean exactly what `isEnrollmentActive` means for
    // the learner's own access — status, not revoked, AND not expired.
    // Leaving `expiresAt` out made the roster report an expired enrollment
    // as active while the learner was already being refused the content
    // (found in browser validation, not by a test).
    const activeCounts = userIds.length
      ? await tx.enrollment.groupBy({
          by: ['studentId'],
          where: {
            academyId,
            studentId: { in: userIds },
            status: { in: ['enrolled', 'completed'] },
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          _count: { _all: true },
        })
      : [];
    const countByStudent = new Map(counts.map((c) => [c.studentId, c._count._all]));
    const activeByStudent = new Map(
      activeCounts.map((c) => [c.studentId, c._count._all]),
    );

    return {
      items: rows.map((row) => ({
        ...row,
        enrollmentCount: countByStudent.get(row.userId) ?? 0,
        activeEnrollmentCount: activeByStudent.get(row.userId) ?? 0,
      })),
      totalItems,
    };
  }

  findMembership(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<
    | (AcademyStudent & {
        user: Pick<
          User,
          'id' | 'name' | 'email' | 'avatarUrl' | 'status' | 'emailVerifiedAt'
        >;
      })
    | null
  > {
    return tx.academyStudent.findFirst({
      where: { academyId, userId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            status: true,
            emailVerifiedAt: true,
          },
        },
      },
    });
  }

  findEnrollmentsForStudent(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
    restrictToCourseIds?: readonly string[],
  ): Promise<RosterEnrollmentRow[]> {
    return tx.enrollment.findMany({
      where: {
        academyId,
        studentId: userId,
        ...(restrictToCourseIds ? { courseId: { in: [...restrictToCourseIds] } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        course: { select: { id: true, title: true, slug: true, status: true } },
        progress: true,
      },
    });
  }

  findQuizAttemptsForStudent(
    tx: Prisma.TransactionClient,
    userId: string,
    courseIds: readonly string[],
  ): Promise<
    (QuizAttempt & { quiz: { id: string; title: string; courseId: string } })[]
  > {
    if (courseIds.length === 0) return Promise.resolve([]);
    return tx.quizAttempt.findMany({
      where: { studentId: userId, quiz: { courseId: { in: [...courseIds] } } },
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
      include: { quiz: { select: { id: true, title: true, courseId: true } } },
    });
  }

  findSubmissionsForStudent(
    tx: Prisma.TransactionClient,
    userId: string,
    courseIds: readonly string[],
  ): Promise<
    (AssignmentSubmission & {
      assignment: { id: string; title: string; courseId: string };
    })[]
  > {
    if (courseIds.length === 0) return Promise.resolve([]);
    return tx.assignmentSubmission.findMany({
      where: { studentId: userId, assignment: { courseId: { in: [...courseIds] } } },
      orderBy: [{ submittedAt: 'desc' }],
      take: 200,
      include: { assignment: { select: { id: true, title: true, courseId: true } } },
    });
  }

  countDevicesForStudent(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    // Phase 1 contract: distinct active sessions stand in for devices
    // until the Phase 2 device registry exists.
    return tx.refreshToken
      .findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        distinct: ['sessionId'],
        select: { sessionId: true },
      })
      .then((rows) => rows.length);
  }

  updateMembership(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.AcademyStudentUpdateInput,
  ): Promise<AcademyStudent> {
    return tx.academyStudent.update({ where: { id }, data });
  }

  findCourseIdsTaughtBy(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<string[]> {
    return tx.courseInstructor
      .findMany({
        where: { userId, course: { academyId } },
        select: { courseId: true },
      })
      .then((rows) => rows.map((row) => row.courseId));
  }
}
