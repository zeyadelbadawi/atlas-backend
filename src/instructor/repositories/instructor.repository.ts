/**
 * InstructorRepository — every cross-student query `InstructorService`
 * needs, all resolved through the additive `*_instructor_select`/
 * `assignment_submissions_instructor_update` RLS policies (P7 migration).
 * Every method takes a `Prisma.TransactionClient` obtained from
 * `TenancyContextService.runInUserContext`, matching every other
 * repository in this codebase's established rule. Never writes
 * `course_instructors` itself (master plan §24) — every method here either
 * reads real P5/P6 data or writes the one real P7 mutation: an assignment
 * submission's grading columns.
 */
import { Injectable } from '@nestjs/common';
import type {
  Assignment,
  AssignmentSubmission,
  Course,
  CourseProgress,
  Enrollment,
  Prisma,
  Quiz,
  QuizAttempt,
  User,
} from '@prisma/client';

export type EnrollmentWithStudent = Enrollment & {
  student: Pick<User, 'id' | 'name' | 'email'>;
  progress: CourseProgress | null;
};

export type QuizAttemptWithStudent = QuizAttempt & {
  student: Pick<User, 'id' | 'name'>;
};

export type SubmissionWithStudent = AssignmentSubmission & {
  student: Pick<User, 'id' | 'name'>;
};

@Injectable()
export class InstructorRepository {
  findCoursesByIds(
    tx: Prisma.TransactionClient,
    courseIds: readonly string[],
    options: { skip: number; take: number },
  ): Promise<{ items: Course[]; totalItems: number }> {
    const where: Prisma.CourseWhereInput = { id: { in: [...courseIds] } };
    return Promise.all([
      tx.course.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      tx.course.count({ where }),
    ]).then(([items, totalItems]) => ({ items, totalItems }));
  }

  findCourseById(tx: Prisma.TransactionClient, courseId: string): Promise<Course | null> {
    return tx.course.findUnique({ where: { id: courseId } });
  }

  countPublishedAmong(
    tx: Prisma.TransactionClient,
    courseIds: readonly string[],
  ): Promise<number> {
    return tx.course.count({
      where: { id: { in: [...courseIds] }, status: 'published' },
    });
  }

  countDistinctActiveStudents(
    tx: Prisma.TransactionClient,
    courseIds: readonly string[],
  ): Promise<number> {
    return tx.enrollment
      .findMany({
        where: {
          courseId: { in: [...courseIds] },
          status: { in: ['enrolled', 'completed'] },
        },
        distinct: ['studentId'],
        select: { studentId: true },
      })
      .then((rows) => rows.length);
  }

  countActiveEnrollmentsForCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<number> {
    return tx.enrollment.count({
      where: { courseId, status: { in: ['enrolled', 'completed'] } },
    });
  }

  async averageProgressForCourse(
    tx: Prisma.TransactionClient,
    courseId: string,
  ): Promise<number | undefined> {
    const result = await tx.courseProgress.aggregate({
      where: { enrollment: { courseId, status: { in: ['enrolled', 'completed'] } } },
      _avg: { percentage: true },
    });
    return result._avg.percentage !== null ? Number(result._avg.percentage) : undefined;
  }

  async findEnrolledStudents(
    tx: Prisma.TransactionClient,
    courseId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: EnrollmentWithStudent[]; totalItems: number }> {
    const where: Prisma.EnrollmentWhereInput = {
      courseId,
      status: { in: ['enrolled', 'completed'] },
    };
    const [items, totalItems] = await Promise.all([
      tx.enrollment.findMany({
        where,
        include: {
          student: { select: { id: true, name: true, email: true } },
          progress: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }) as Promise<EnrollmentWithStudent[]>,
      tx.enrollment.count({ where }),
    ]);
    return { items, totalItems };
  }

  findEnrollmentWithProgress(
    tx: Prisma.TransactionClient,
    courseId: string,
    studentId: string,
  ): Promise<EnrollmentWithStudent | null> {
    return tx.enrollment.findUnique({
      where: { studentId_courseId: { studentId, courseId } },
      include: {
        student: { select: { id: true, name: true, email: true } },
        progress: true,
      },
    }) as Promise<EnrollmentWithStudent | null>;
  }

  countPendingSubmissions(
    tx: Prisma.TransactionClient,
    courseIds: readonly string[],
  ): Promise<number> {
    return tx.assignmentSubmission.count({
      where: { status: 'submitted', assignment: { courseId: { in: [...courseIds] } } },
    });
  }

  countPendingGrading(
    tx: Prisma.TransactionClient,
    courseIds: readonly string[],
  ): Promise<number> {
    return tx.assignmentSubmission.count({
      where: {
        status: 'submitted',
        gradingStatus: 'ungraded',
        assignment: { courseId: { in: [...courseIds] } },
      },
    });
  }

  findQuizById(tx: Prisma.TransactionClient, quizId: string): Promise<Quiz | null> {
    return tx.quiz.findUnique({ where: { id: quizId } });
  }

  findAssignmentById(
    tx: Prisma.TransactionClient,
    assignmentId: string,
  ): Promise<Assignment | null> {
    return tx.assignment.findUnique({ where: { id: assignmentId } });
  }

  async findQuizAttemptsForQuiz(
    tx: Prisma.TransactionClient,
    quizId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: QuizAttemptWithStudent[]; totalItems: number }> {
    const where: Prisma.QuizAttemptWhereInput = { quizId };
    const [items, totalItems] = await Promise.all([
      tx.quizAttempt.findMany({
        where,
        include: { student: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }) as Promise<QuizAttemptWithStudent[]>,
      tx.quizAttempt.count({ where }),
    ]);
    return { items, totalItems };
  }

  findQuizAttemptsForStudentInCourse(
    tx: Prisma.TransactionClient,
    studentId: string,
    courseId: string,
  ): Promise<QuizAttempt[]> {
    return tx.quizAttempt.findMany({
      where: { studentId, quiz: { courseId } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findSubmissionsForAssignment(
    tx: Prisma.TransactionClient,
    assignmentId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: SubmissionWithStudent[]; totalItems: number }> {
    const where: Prisma.AssignmentSubmissionWhereInput = { assignmentId };
    const [items, totalItems] = await Promise.all([
      tx.assignmentSubmission.findMany({
        where,
        include: { student: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }) as Promise<SubmissionWithStudent[]>,
      tx.assignmentSubmission.count({ where }),
    ]);
    return { items, totalItems };
  }

  findSubmissionsForStudentInCourse(
    tx: Prisma.TransactionClient,
    studentId: string,
    courseId: string,
  ): Promise<AssignmentSubmission[]> {
    return tx.assignmentSubmission.findMany({
      where: { studentId, assignment: { courseId } },
      orderBy: { createdAt: 'desc' },
    });
  }

  findSubmissionById(
    tx: Prisma.TransactionClient,
    submissionId: string,
  ): Promise<SubmissionWithStudent | null> {
    return tx.assignmentSubmission.findUnique({
      where: { id: submissionId },
      include: { student: { select: { id: true, name: true } } },
    }) as Promise<SubmissionWithStudent | null>;
  }

  gradeSubmission(
    tx: Prisma.TransactionClient,
    submissionId: string,
    data: { score?: number; feedback?: string; gradedBy: string },
  ): Promise<AssignmentSubmission> {
    return tx.assignmentSubmission.update({
      where: { id: submissionId },
      data: {
        gradingStatus: 'graded',
        score: data.score,
        feedback: data.feedback,
        gradedAt: new Date(),
        grader: { connect: { id: data.gradedBy } },
      },
    });
  }

  /** Recent, real cross-student events for the dashboard/overview activity feed — never fabricated. Each source query is capped and the merged result re-sorted/truncated by the service. */
  findRecentEnrollments(
    tx: Prisma.TransactionClient,
    courseIds: readonly string[],
    limit: number,
  ): Promise<
    (Enrollment & { student: Pick<User, 'name'>; course: Pick<Course, 'title'> })[]
  > {
    return tx.enrollment.findMany({
      where: { courseId: { in: [...courseIds] } },
      include: {
        student: { select: { name: true } },
        course: { select: { title: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  findRecentQuizAttempts(
    tx: Prisma.TransactionClient,
    courseIds: readonly string[],
    limit: number,
  ): Promise<
    (QuizAttempt & {
      student: Pick<User, 'name'>;
      quiz: { title: string; courseId: string; course: Pick<Course, 'title'> };
    })[]
  > {
    return tx.quizAttempt.findMany({
      where: {
        status: { in: ['passed', 'failed'] },
        quiz: { courseId: { in: [...courseIds] } },
      },
      include: {
        student: { select: { name: true } },
        quiz: {
          select: { title: true, courseId: true, course: { select: { title: true } } },
        },
      },
      orderBy: { submittedAt: 'desc' },
      take: limit,
    });
  }

  findRecentSubmissions(
    tx: Prisma.TransactionClient,
    courseIds: readonly string[],
    limit: number,
  ): Promise<
    (AssignmentSubmission & {
      student: Pick<User, 'name'>;
      assignment: { title: string; courseId: string; course: Pick<Course, 'title'> };
    })[]
  > {
    return tx.assignmentSubmission.findMany({
      where: { status: 'submitted', assignment: { courseId: { in: [...courseIds] } } },
      include: {
        student: { select: { name: true } },
        assignment: {
          select: { title: true, courseId: true, course: { select: { title: true } } },
        },
      },
      orderBy: { submittedAt: 'desc' },
      take: limit,
    });
  }
}
