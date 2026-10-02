/**
 * P64 Phase 3 (§E.7) — what a reviewer (course instructor, academy
 * manager or owner — `assertCanReviewCourse`) sees of an attempt: the
 * learner's answers WITH correctness, the manual-grading state, and the
 * integrity timeline. Reachable only through the review tier; a learner
 * never receives this shape.
 */
import type {
  QuizAttempt as PrismaQuizAttempt,
  QuizAttemptEvent as PrismaQuizAttemptEvent,
  QuizStudentOverride as PrismaQuizStudentOverride,
} from '@prisma/client';
import {
  toQuizAttemptResponse,
  type QuizAttemptResponse,
} from '../../learning/dto/quiz-attempt.contract';
import type {
  EngineQuestion,
  QuestionScore,
  AttemptAnswer,
} from '../../learning/services/quiz-engine.util';
import {
  deriveIntegritySignals,
  type IntegritySignal,
} from '../../learning/services/integrity-signals.util';

export interface ReviewAnswerResponse {
  readonly questionId: string;
  readonly prompt: string;
  readonly type: EngineQuestion['type'];
  readonly points: number;
  readonly answered: boolean;
  readonly correct: boolean | null;
  readonly pointsAwarded: number;
  readonly needsManualGrading: boolean;
  readonly manualPoints: number | null;
  readonly selectedOptionIds?: readonly string[];
  readonly text?: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly isCorrect: boolean;
  }[];
  readonly acceptedAnswers?: readonly string[];
}

export interface AttemptEventResponse {
  readonly id: string;
  readonly type: PrismaQuizAttemptEvent['type'];
  readonly counted: boolean;
  readonly clientAt: string | null;
  readonly serverAt: string;
  readonly payload: unknown;
}

export interface QuizAttemptReviewResponse extends QuizAttemptResponse {
  readonly studentName: string;
  readonly studentEmail: string;
  readonly durationSeconds: number | null;
  readonly questions: readonly ReviewAnswerResponse[];
  readonly events: readonly AttemptEventResponse[];
  readonly gradedByName: string | null;
  readonly invalidatedByName: string | null;
  /**
   * The integrity mode in force FOR THIS ATTEMPT, read from its settings
   * snapshot — `off` when the quiz had integrity off OR the academy's
   * `quiz.integrity` flag was not on when the attempt ran. It lets the
   * reviewer tell "integrity was not watching" from "integrity was watching
   * and recorded nothing" (P4 Issue 5): an empty event list means different
   * things in those two cases, and reporting both as "no events" read as the
   * whole feature being broken.
   */
  readonly integrityMode: 'off' | 'monitor' | 'warn' | 'strict';
  /** Whether this attempt required full screen (its settings snapshot). */
  readonly requireFullscreen: boolean;
  /** The event limit in force for this attempt (its settings snapshot). */
  readonly maxViolations: number;
  /**
   * P5 — the explainable signals derived from `events`
   * (`deriveIntegritySignals`): facts worth a look, with their evidence.
   * Never a score or a verdict.
   */
  readonly signals: readonly IntegritySignal[];
}

function snapshotMaxViolations(snapshot: PrismaQuizAttempt['settingsSnapshot']): number {
  const value =
    snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>).maxViolations
      : undefined;
  return typeof value === 'number' ? value : 0;
}

function snapshotRequiresFullscreen(
  snapshot: PrismaQuizAttempt['settingsSnapshot'],
): boolean {
  return (
    !!snapshot &&
    typeof snapshot === 'object' &&
    !Array.isArray(snapshot) &&
    (snapshot as Record<string, unknown>).requireFullscreen === true
  );
}

/** Reads the effective integrity mode from an attempt's frozen settings snapshot. */
function snapshotIntegrityMode(
  snapshot: PrismaQuizAttempt['settingsSnapshot'],
): 'off' | 'monitor' | 'warn' | 'strict' {
  const mode =
    snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>).integrityMode
      : undefined;
  return mode === 'monitor' || mode === 'warn' || mode === 'strict' ? mode : 'off';
}

export interface QuizStudentOverrideResponse {
  readonly id: string;
  readonly quizId: string;
  readonly studentId: string;
  readonly studentName: string | null;
  readonly timeMultiplier: number;
  readonly extraAttempts: number;
  readonly availableFrom: string | null;
  readonly availableUntil: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
}

export function toOverrideResponse(
  row: PrismaQuizStudentOverride,
  studentName: string | null,
): QuizStudentOverrideResponse {
  return {
    id: row.id,
    quizId: row.quizId,
    studentId: row.studentId,
    studentName,
    timeMultiplier: Number(row.timeMultiplier),
    extraAttempts: row.extraAttempts,
    availableFrom: row.availableFrom?.toISOString() ?? null,
    availableUntil: row.availableUntil?.toISOString() ?? null,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toReviewAnswer(
  question: EngineQuestion,
  answer: AttemptAnswer | undefined,
  score: QuestionScore | undefined,
  manualPoints: number | null,
): ReviewAnswerResponse {
  return {
    questionId: question.id,
    prompt: question.prompt,
    type: question.type,
    points: question.points,
    answered: score?.answered ?? Boolean(answer),
    correct: score?.correct ?? null,
    pointsAwarded: score?.pointsAwarded ?? 0,
    needsManualGrading: score?.needsManualGrading ?? false,
    manualPoints,
    ...(answer?.selectedOptionIds
      ? { selectedOptionIds: [...answer.selectedOptionIds] }
      : {}),
    ...(answer?.text !== undefined ? { text: answer.text } : {}),
    options: question.options.map((option) => ({
      id: option.id,
      label: option.label,
      isCorrect: option.isCorrect,
    })),
    ...(question.acceptedAnswers
      ? { acceptedAnswers: [...question.acceptedAnswers] }
      : {}),
  };
}

export function toAttemptReviewResponse(
  attempt: PrismaQuizAttempt,
  student: { name: string; email: string },
  questions: readonly ReviewAnswerResponse[],
  events: readonly PrismaQuizAttemptEvent[],
  names: { gradedBy: string | null; invalidatedBy: string | null },
  now: Date = new Date(),
): QuizAttemptReviewResponse {
  const started = attempt.startedAt ?? attempt.createdAt;
  const integrityMode = snapshotIntegrityMode(attempt.settingsSnapshot);
  const requireFullscreen = snapshotRequiresFullscreen(attempt.settingsSnapshot);
  const duration = attempt.submittedAt
    ? Math.max(0, Math.round((attempt.submittedAt.getTime() - started.getTime()) / 1000))
    : null;
  return {
    ...toQuizAttemptResponse(attempt, false),
    studentName: student.name,
    studentEmail: student.email,
    durationSeconds: duration,
    questions,
    events: events.map((event) => ({
      id: event.id,
      type: event.type,
      counted: event.counted,
      clientAt: event.clientAt?.toISOString() ?? null,
      serverAt: event.serverAt.toISOString(),
      payload: event.payload,
    })),
    gradedByName: names.gradedBy,
    invalidatedByName: names.invalidatedBy,
    integrityMode,
    requireFullscreen,
    maxViolations: snapshotMaxViolations(attempt.settingsSnapshot),
    signals: deriveIntegritySignals({
      events,
      startedAt: started,
      endedAt: attempt.submittedAt ?? now,
      integrityMode,
      requireFullscreen,
    }),
  };
}

/** One CSV row per attempt for the integrity export (§D.3). */
export function integrityCsvRow(
  attempt: PrismaQuizAttempt,
  studentName: string,
  studentEmail: string,
  eventCounts: Readonly<Record<string, number>>,
): string {
  const cells = [
    attempt.id,
    studentName,
    studentEmail,
    attempt.attemptNumber,
    attempt.status,
    attempt.startedAt?.toISOString() ?? attempt.createdAt.toISOString(),
    attempt.submittedAt?.toISOString() ?? '',
    attempt.score !== null ? Number(attempt.score) : '',
    attempt.violationCount,
    attempt.integrityFlagged ? 'yes' : 'no',
    attempt.autoSubmittedReason ?? '',
    attempt.isLate ? 'yes' : 'no',
    eventCounts.visibility_hidden ?? 0,
    eventCounts.blur ?? 0,
    eventCounts.fullscreen_exit ?? 0,
    (eventCounts.copy ?? 0) + (eventCounts.paste ?? 0) + (eventCounts.cut ?? 0),
    eventCounts.contextmenu ?? 0,
    eventCounts.print ?? 0,
    eventCounts.second_session ?? 0,
    eventCounts.device_change ?? 0,
    eventCounts.fullscreen_unavailable ?? 0,
  ];
  return cells.map(csvCell).join(',');
}

export const INTEGRITY_CSV_HEADER = [
  'attempt_id',
  'student_name',
  'student_email',
  'attempt_number',
  'status',
  'started_at',
  'submitted_at',
  'score',
  'violations_counted',
  'flagged',
  'auto_submitted_reason',
  'late',
  'tab_hidden',
  'window_blur',
  'fullscreen_exit',
  'clipboard',
  'context_menu',
  'print',
  'second_session',
  'device_change',
  'fullscreen_unavailable',
].join(',');

/** Quotes every cell and neutralises spreadsheet formula injection (`=`, `+`, `-`, `@`). */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
