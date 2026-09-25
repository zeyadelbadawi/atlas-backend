/**
 * Learner-activity guard for destructive authoring deletes (cloud
 * remediation, finding D).
 *
 * THE DEFECT. Deleting a section, lesson, quiz or assignment is a real
 * `DELETE`, and the foreign keys below it are `ON DELETE CASCADE`:
 *
 *   course_sections → course_lessons → lesson_progress
 *   quizzes         → quiz_attempts, quiz_results
 *   assignments     → assignment_submissions
 *
 * Referential actions run with the table owner's rights, not the caller's,
 * so RLS does not stop them. An instructor tidying a curriculum therefore
 * erased every learner's progress, attempts, grades and submissions for
 * that item, silently and irreversibly — contradicting the lifecycle model
 * in `docs/ACCOUNT_DELETION_AND_DATA_LIFECYCLE.md` ("Atlas deletes the
 * person and the bytes. It does not delete the record.").
 *
 * THE RULE. Content no learner has touched may still be deleted — that is
 * ordinary authoring. Content a learner HAS touched may not; the author
 * unpublishes it instead (status `draft`), which hides it from learners
 * and keeps their record. The refusal is a 409 carrying
 * `errors.course.hasLearnerActivity`, which the UI renders as that advice.
 *
 * CONTEXT. Must run in the owning organization's TENANT context: every
 * learner table has a `*_tenant_select` policy keyed on
 * `app.current_organization_id`, so the count is complete for that tenant.
 * Run in a user context instead it could see only part of the rows — and a
 * partial zero here would authorize exactly the erasure this prevents.
 */
import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export type LearnerActivityTarget =
  | { readonly kind: 'section'; readonly id: string }
  | { readonly kind: 'lesson'; readonly id: string }
  | { readonly kind: 'quiz'; readonly id: string }
  | { readonly kind: 'assignment'; readonly id: string };

export const HAS_LEARNER_ACTIVITY_MESSAGE_KEY = 'errors.course.hasLearnerActivity';

/** Whether any learner record would be destroyed by deleting `target`. */
export async function hasLearnerActivity(
  tx: Prisma.TransactionClient,
  target: LearnerActivityTarget,
): Promise<boolean> {
  switch (target.kind) {
    case 'section':
      return (
        (await tx.lessonProgress.findFirst({
          where: { lesson: { sectionId: target.id } },
          select: { id: true },
        })) !== null
      );
    case 'lesson':
      return (
        (await tx.lessonProgress.findFirst({
          where: { lessonId: target.id },
          select: { id: true },
        })) !== null
      );
    case 'quiz': {
      const [attempt, result] = await Promise.all([
        tx.quizAttempt.findFirst({ where: { quizId: target.id }, select: { id: true } }),
        tx.quizResult.findFirst({ where: { quizId: target.id }, select: { id: true } }),
      ]);
      return attempt !== null || result !== null;
    }
    case 'assignment':
      return (
        (await tx.assignmentSubmission.findFirst({
          where: { assignmentId: target.id },
          select: { id: true },
        })) !== null
      );
  }
}

/** Throws the 409 when deleting `target` would destroy learner records. */
export async function assertNoLearnerActivity(
  tx: Prisma.TransactionClient,
  target: LearnerActivityTarget,
): Promise<void> {
  if (await hasLearnerActivity(tx, target)) {
    throw new ConflictException({ messageKey: HAS_LEARNER_ACTIVITY_MESSAGE_KEY });
  }
}
