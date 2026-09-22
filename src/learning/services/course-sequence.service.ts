/**
 * `CourseSequenceService` — builds the one ordered curriculum the player
 * drives everything from (master plan Phase 2 §D.3, Finding F3).
 *
 * THE ORDERING BUG THIS FIXES. `CourseContentService` already merges
 * lessons, quizzes and assignments per unit, but it breaks ties with
 * `x.type.localeCompare(y.type)` — so two items an author deliberately
 * placed at the same ordinal come back in ALPHABETICAL TYPE order
 * (assignment, lesson, quiz), which is not an order any author chose and
 * is not the order the authoring screen shows. Phase 2 §D.3 calls this
 * out as "assignment/quiz ordering bug fixed". Here the tie-break is
 * creation time, which at least reflects the order the author actually
 * built them in, and is stable across requests.
 *
 * LIVE SESSIONS ARE INCLUDED HERE, unlike in the sections projection.
 * That is not an inconsistency: §D.3 asks the sequence to span all four
 * types precisely so Previous/Next cannot skip a scheduled session, while
 * the older sections endpoint deliberately omits them. Only PUBLISHED,
 * non-draft sessions appear, so nothing unannounced leaks.
 *
 * STATE IS DERIVED, NEVER STORED. A second copy of "is this done" would
 * drift from `lesson_progress` / `quiz_attempts` / `assignment_submissions`
 * the first time any of them changed outside this service.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CourseInstructorsRepository } from '../../course/repositories/course-instructors.repository';
import { assertCourseReadAccess, isEnrollmentActive } from './learning-access.util';
import type {
  CourseSequenceItem,
  CourseSequenceResponse,
  SequenceItemState,
  SequenceLockReason,
} from '../dto/course-sequence.contract';

/** Everything the ordering needs, before state is layered on. */
interface RawItem {
  readonly id: string;
  readonly type: CourseSequenceItem['type'];
  readonly title: string;
  readonly sectionId: string;
  readonly order: number;
  readonly createdAt: Date;
  readonly durationSeconds: number | null;
  readonly isPreview: boolean;
  readonly dueAt: Date | null;
  readonly availableAt: Date | null;
}

@Injectable()
export class CourseSequenceService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly courseInstructorsRepository: CourseInstructorsRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
  ) {}

  async getSequence(userId: string, courseId: string): Promise<CourseSequenceResponse> {
    return this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.build(tx, userId, courseId),
    );
  }

  /**
   * The items alone, for a caller that ALREADY holds the user context.
   *
   * `CourseContentService` needs the same lock states for its curriculum
   * projection, and it is already inside `runInUserContext`. Calling
   * `getSequence` from there would open a second, nested transaction for
   * the same read — so the context-opening and the work are separate
   * methods, and the work never opens a transaction of its own.
   */
  async getSequenceItems(
    tx: Prisma.TransactionClient,
    userId: string,
    courseId: string,
  ): Promise<readonly CourseSequenceItem[]> {
    const sequence = await this.build(tx, userId, courseId);
    return sequence.items;
  }

  private async build(
    tx: Prisma.TransactionClient,
    userId: string,
    courseId: string,
  ): Promise<CourseSequenceResponse> {
    {
      // The same read gate every other student-facing curriculum read
      // uses — active enrollment, course instructor, or academy manager.
      await assertCourseReadAccess(
        tx,
        this.enrollmentsRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
        undefined,
        this.academyStudentsRepository,
      );

      const course = await tx.course.findUnique({
        where: { id: courseId },
        select: { id: true, title: true },
      });
      if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const sections = await tx.courseSection.findMany({
        where: { courseId },
        orderBy: { order: 'asc' },
        select: { id: true, title: true, order: true },
      });

      const [lessons, quizzes, assignments, liveSessions] = await Promise.all([
        tx.courseLesson.findMany({
          where: { courseId, status: 'published' },
          select: {
            id: true,
            title: true,
            sectionId: true,
            order: true,
            createdAt: true,
            durationSeconds: true,
            isPreview: true,
            availableAt: true,
            videoAsset: { select: { durationSeconds: true } },
          },
        }),
        tx.quiz.findMany({
          where: { courseId, status: 'published', sectionId: { not: null } },
          select: {
            id: true,
            title: true,
            sectionId: true,
            order: true,
            createdAt: true,
          },
        }),
        tx.assignment.findMany({
          where: { courseId, status: 'published', sectionId: { not: null } },
          select: {
            id: true,
            title: true,
            sectionId: true,
            order: true,
            createdAt: true,
            dueAt: true,
          },
        }),
        tx.liveSession.findMany({
          where: { courseId, status: { not: 'draft' }, sectionId: { not: null } },
          select: {
            id: true,
            title: true,
            sectionId: true,
            order: true,
            createdAt: true,
            scheduledStartAt: true,
          },
        }),
      ]);

      const enrollment = await this.enrollmentsRepository.findByStudentAndCourse(
        tx,
        userId,
        courseId,
      );
      const accessEnded = Boolean(enrollment) && !isEnrollmentActive(enrollment!);

      const lessonProgress = enrollment
        ? await tx.lessonProgress.findMany({
            where: { enrollmentId: enrollment.id },
            select: { lessonId: true, status: true },
          })
        : [];
      const lessonState = new Map(
        lessonProgress.map((row) => [row.lessonId, row.status]),
      );

      // Best attempt per quiz: a learner who passed on the second try has
      // passed, and showing the first attempt's failure instead would be
      // both wrong and demoralising.
      const attempts = await tx.quizAttempt.findMany({
        where: { studentId: userId, quiz: { courseId } },
        select: { quizId: true, status: true },
      });
      const quizState = new Map<string, SequenceItemState>();
      for (const attempt of attempts) {
        const mapped = mapQuizState(attempt.status);
        const current = quizState.get(attempt.quizId);
        if (!current || rank(mapped) > rank(current))
          quizState.set(attempt.quizId, mapped);
      }

      const submissions = await tx.assignmentSubmission.findMany({
        where: { studentId: userId, assignment: { courseId } },
        select: { assignmentId: true, status: true, gradingStatus: true },
      });
      const assignmentState = new Map<string, SequenceItemState>(
        submissions.map((submission) => [
          submission.assignmentId,
          submission.gradingStatus === 'graded'
            ? 'graded'
            : submission.status === 'submitted'
              ? 'submitted'
              : 'in_progress',
        ]),
      );

      const raw: RawItem[] = [
        ...lessons.map((lesson) => ({
          id: lesson.id,
          type: 'lesson' as const,
          title: lesson.title,
          sectionId: lesson.sectionId,
          order: lesson.order,
          createdAt: lesson.createdAt,
          durationSeconds:
            lesson.durationSeconds ?? lesson.videoAsset?.durationSeconds ?? null,
          isPreview: lesson.isPreview,
          dueAt: null,
          availableAt: lesson.availableAt,
        })),
        ...quizzes.map((quiz) => ({
          id: quiz.id,
          type: 'quiz' as const,
          title: quiz.title,
          sectionId: quiz.sectionId!,
          order: quiz.order,
          createdAt: quiz.createdAt,
          durationSeconds: null,
          isPreview: false,
          dueAt: null,
          availableAt: null,
        })),
        ...assignments.map((assignment) => ({
          id: assignment.id,
          type: 'assignment' as const,
          title: assignment.title,
          sectionId: assignment.sectionId!,
          order: assignment.order,
          createdAt: assignment.createdAt,
          durationSeconds: null,
          isPreview: false,
          dueAt: assignment.dueAt,
          availableAt: null,
        })),
        ...liveSessions.map((session) => ({
          id: session.id,
          type: 'live_session' as const,
          title: session.title,
          sectionId: session.sectionId!,
          order: session.order,
          createdAt: session.createdAt,
          durationSeconds: null,
          isPreview: false,
          dueAt: session.scheduledStartAt,
          availableAt: session.scheduledStartAt,
        })),
      ];

      const now = new Date();
      const items: CourseSequenceItem[] = [];
      let position = 0;
      // Sequential unlock carries ACROSS units, exactly as
      // `backfillLessonProgress` already treats the curriculum: an item is
      // locked while anything before it in the whole course is unfinished.
      let previousFinished = true;

      sections.forEach((section, sectionIndex) => {
        const inSection = raw
          .filter((item) => item.sectionId === section.id)
          .sort(
            (a, b) =>
              a.order - b.order ||
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          );

        inSection.forEach((item, itemIndex) => {
          const { state, lockReason } = deriveState({
            item,
            now,
            accessEnded,
            previousFinished,
            lessonState,
            quizState,
            assignmentState,
          });
          items.push({
            id: item.id,
            type: item.type,
            title: item.title,
            sectionId: section.id,
            sectionTitle: section.title,
            unitNumber: sectionIndex + 1,
            itemNumber: itemIndex + 1,
            position: position++,
            state,
            lockReason,
            durationSeconds: item.durationSeconds,
            isPreview: item.isPreview,
            dueAt: item.dueAt?.toISOString() ?? null,
            availableAt: item.availableAt?.toISOString() ?? null,
          });
          previousFinished = isFinished(state);
        });
      });

      const completedCount = items.filter((item) => isFinished(item.state)).length;
      return {
        courseId: course.id,
        courseTitle: course.title,
        items,
        continueItemId:
          items.find((item) => !isFinished(item.state) && item.state !== 'locked')?.id ??
          null,
        completedCount,
        totalCount: items.length,
      };
    }
  }
}

/** "Finished" for the purpose of sequential unlock and the progress count. */
function isFinished(state: SequenceItemState): boolean {
  return (
    state === 'completed' ||
    state === 'passed' ||
    state === 'graded' ||
    state === 'submitted'
  );
}

/** Which of two quiz attempt outcomes is the better one to show. */
function rank(state: SequenceItemState): number {
  switch (state) {
    case 'passed':
      return 4;
    case 'submitted':
      return 3;
    case 'failed':
      return 2;
    case 'in_progress':
      return 1;
    default:
      return 0;
  }
}

function mapQuizState(status: string): SequenceItemState {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'submitted':
      return 'submitted';
    case 'in_progress':
      return 'in_progress';
    default:
      return 'available';
  }
}

function deriveState(args: {
  readonly item: RawItem;
  readonly now: Date;
  readonly accessEnded: boolean;
  readonly previousFinished: boolean;
  readonly lessonState: Map<string, string>;
  readonly quizState: Map<string, SequenceItemState>;
  readonly assignmentState: Map<string, SequenceItemState>;
}): { state: SequenceItemState; lockReason: SequenceLockReason | null } {
  const { item, now } = args;

  // Access ending outranks everything. A learner whose refund went through
  // sees the shape of the course they bought and one consistent reason,
  // not a mix of per-item states that imply some of it is still theirs.
  // A PREVIEW item is the exception — it was never theirs by enrollment.
  if (args.accessEnded && !item.isPreview) {
    return { state: 'locked', lockReason: 'accessEnded' };
  }

  if (item.availableAt && item.availableAt.getTime() > now.getTime()) {
    return {
      state: 'locked',
      lockReason: item.type === 'live_session' ? 'notStarted' : 'scheduled',
    };
  }

  const existing =
    item.type === 'lesson'
      ? mapLessonState(args.lessonState.get(item.id))
      : item.type === 'quiz'
        ? args.quizState.get(item.id)
        : item.type === 'assignment'
          ? args.assignmentState.get(item.id)
          : undefined;

  if (existing && existing !== 'available') return { state: existing, lockReason: null };

  // Sequential unlock. A preview lesson is deliberately never locked by
  // it: preview exists to be opened before anything else has been.
  if (!args.previousFinished && !item.isPreview) {
    return { state: 'locked', lockReason: 'previousIncomplete' };
  }

  if (item.type === 'assignment' && item.dueAt && item.dueAt.getTime() < now.getTime()) {
    return { state: 'overdue', lockReason: null };
  }

  return { state: 'available', lockReason: null };
}

function mapLessonState(status: string | undefined): SequenceItemState | undefined {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'in_progress':
      return 'in_progress';
    case 'available':
      return 'available';
    case 'locked':
      return undefined;
    default:
      return undefined;
  }
}
