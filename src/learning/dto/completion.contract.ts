/**
 * P64 Phase 3 (AD-11, §E.5) — completion as the learner sees it, and the
 * completion rule as staff configure it.
 */
import type { CompletionRule, MissingItem } from '../services/completion-rule.util';

export interface CompletionRequiredQuizResponse {
  readonly quizId: string;
  readonly title: string;
  readonly required: boolean;
  readonly passed: boolean;
  readonly effectiveScore: number | null;
  readonly pendingGrading: boolean;
}

export interface CompletionRequiredAssignmentResponse {
  readonly assignmentId: string;
  readonly title: string;
  readonly required: boolean;
  readonly submitted: boolean;
  readonly graded: boolean;
  readonly score: number | null;
}

export interface CompletionCertificateResponse {
  /** Whether certificates are enabled for this course AND the rollout flag admits this academy. */
  readonly enabled: boolean;
  readonly status: 'unavailable' | 'eligible' | 'issued' | 'revoked';
  readonly minScore: number | null;
  readonly certificateId: string | null;
  readonly serial: string | null;
  readonly verificationCode: string | null;
  readonly renderStatus: 'pending' | 'ready' | 'failed' | null;
  readonly issuedAt: string | null;
}

export interface CourseCompletionResponse {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly completed: boolean;
  readonly completedAt: string | null;
  readonly completionState: 'incomplete' | 'in_progress' | 'completed';
  readonly overallScore: number | null;
  readonly rule: CompletionRule;
  readonly lessons: { readonly total: number; readonly completed: number };
  readonly quizzes: readonly CompletionRequiredQuizResponse[];
  readonly assignments: readonly CompletionRequiredAssignmentResponse[];
  readonly missing: readonly MissingItem[];
  readonly certificate: CompletionCertificateResponse;
}

/** Staff view of a course's rule and the items it can require. */
export interface CourseCompletionRuleResponse {
  readonly courseId: string;
  readonly rule: CompletionRule;
  readonly certificatesEnabled: boolean;
  readonly certificateMinScore: number | null;
  readonly certificateTemplateId: string | null;
  /** The rollout flag for this academy — settings still save when it is off, issuance waits. */
  readonly certificatesFeatureEnabled: boolean;
  readonly quizzes: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly requiredForCompletion: boolean;
  }[];
  readonly assignments: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly requiredForCompletion: boolean;
  }[];
  readonly publishedLessons: number;
}
