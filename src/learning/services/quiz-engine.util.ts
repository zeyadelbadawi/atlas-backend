/**
 * P64 Phase 3 — the quiz engine's pure core (AD-8, AD-9).
 *
 * Everything that decides a deadline, an order, a score, a disclosure or
 * an integrity escalation lives here as a function of explicit inputs —
 * including `now`, which is always passed in and never read from the
 * wall clock. That is what makes the engine testable with a fake clock
 * (master plan Phase 3 §N) and what keeps the service layer honest: the
 * service fetches rows and calls these; it never re-derives a rule.
 *
 * Nothing here trusts the client. Answers are validated against the
 * attempt's own question set, option ids against their question, text
 * lengths against fixed ceilings, and event timestamps are recorded but
 * never used for ordering or escalation — the server timestamp is.
 */
import type {
  AssessmentLatePolicy,
  QuizDisclosure,
  QuizGradingPolicy,
  QuizIntegrityMode,
  QuizLayout,
  QuizMode,
  QuizQuestionType,
  QuizAttemptEventType,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Saves and submits are accepted this long after `deadline_at`, to absorb network latency. */
export const QUIZ_SUBMIT_GRACE_SECONDS = 30;
/** Auto-submit job fires at `deadline + grace`; the sweep catches anything the job missed. */
export const QUIZ_AUTO_SUBMIT_DELAY_SECONDS = QUIZ_SUBMIT_GRACE_SECONDS;
export const MAX_SHORT_ANSWER_LENGTH = 2_000;
export const MAX_ESSAY_LENGTH = 20_000;
export const MAX_EVENTS_PER_BATCH = 50;
/** Two events of the same type inside this window count once. */
export const INTEGRITY_DEBOUNCE_MS = 2_000;
/** Nothing counts during the first seconds after start (page settling). */
export const INTEGRITY_WARM_UP_MS = 5_000;
/** A hide→show shorter than this is a notification bubble, not a tab switch. */
export const INTEGRITY_SUB_SECOND_MS = 1_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuizSettingsSnapshot {
  readonly mode: QuizMode;
  readonly timeLimitSeconds: number | null;
  readonly availableFrom: string | null;
  readonly availableUntil: string | null;
  readonly dueAt: string | null;
  readonly latePolicy: AssessmentLatePolicy;
  readonly gradingPolicy: QuizGradingPolicy;
  readonly shuffleQuestions: boolean;
  readonly shuffleOptions: boolean;
  readonly questionsPerAttempt: number | null;
  readonly layout: QuizLayout;
  readonly showScore: QuizDisclosure;
  readonly showAnswers: QuizDisclosure;
  readonly showExplanations: boolean;
  readonly integrityMode: QuizIntegrityMode;
  readonly maxViolations: number;
  readonly requireFullscreen: boolean;
  readonly hideTimer: boolean;
  readonly passingScore: number | null;
  readonly maxAttempts: number | null;
  /** The per-student accommodation applied at start, if any. */
  readonly timeMultiplier: number;
  readonly extraAttempts: number;
  /** Option order per question, decided at start when `shuffleOptions` is on. */
  readonly optionOrder: Readonly<Record<string, readonly string[]>>;
  /** Whether the v2 engine (timer, shuffle, windows, integrity) was on for this attempt. */
  readonly engineV2: boolean;
}

export interface EngineOption {
  readonly id: string;
  readonly label: string;
  readonly isCorrect: boolean;
}

export interface EngineQuestion {
  readonly id: string;
  readonly type: QuizQuestionType;
  readonly prompt: string;
  readonly points: number;
  readonly order: number;
  readonly explanation: string | null;
  readonly relatedLessonId: string | null;
  readonly acceptedAnswers: readonly string[] | null;
  readonly options: readonly EngineOption[];
}

export interface AttemptAnswer {
  readonly questionId: string;
  readonly selectedOptionIds?: readonly string[];
  readonly text?: string;
}

export type AnswerValidationError =
  | 'unknownQuestion'
  | 'duplicateQuestion'
  | 'invalidOption'
  | 'textTooLong'
  | 'wrongAnswerShape';

export interface QuestionScore {
  readonly questionId: string;
  /** `null` while a manual question is ungraded. */
  readonly correct: boolean | null;
  readonly pointsAwarded: number;
  readonly pointsPossible: number;
  readonly needsManualGrading: boolean;
  readonly answered: boolean;
}

export interface AttemptScore {
  readonly pointsEarned: number;
  readonly pointsTotal: number;
  /** 0–100, two decimals. `null` while manual grading is pending. */
  readonly score: number | null;
  readonly pendingManual: boolean;
  readonly perQuestion: readonly QuestionScore[];
}

export interface FinalizedAttemptSummary {
  readonly id: string;
  readonly attemptNumber: number;
  readonly score: number | null;
  readonly passed: boolean | null;
  readonly submittedAt: Date;
  readonly pendingGrading: boolean;
}

export interface AggregatedResult {
  readonly attemptsCount: number;
  readonly bestScore: number | null;
  readonly latestScore: number | null;
  readonly effectiveScore: number | null;
  readonly effectiveAttemptId: string | null;
  readonly passed: boolean;
  readonly pendingGrading: boolean;
}

export interface DisclosureInput {
  readonly showScore: QuizDisclosure;
  readonly showAnswers: QuizDisclosure;
  readonly showExplanations: boolean;
  readonly now: Date;
  readonly dueAt: Date | null;
  readonly availableUntil: Date | null;
  readonly attemptsUsed: number;
  readonly maxAttempts: number | null;
  readonly attemptFinalized: boolean;
}

export interface Disclosure {
  readonly score: boolean;
  readonly answers: boolean;
  readonly explanations: boolean;
}

export interface IncomingEvent {
  readonly type: QuizAttemptEventType;
  readonly clientAt: Date | null;
  readonly payload?: Record<string, unknown> | null;
}

export interface IntegrityDecisionInput {
  readonly mode: QuizIntegrityMode;
  readonly maxViolations: number;
  readonly violationCount: number;
  readonly startedAt: Date;
  readonly now: Date;
  /** Server time of the last COUNTED event per type, for debounce. */
  readonly lastCountedAt: ReadonlyMap<QuizAttemptEventType, Date>;
  /** Server time of the last `visibility_hidden` seen (counted or not), for the sub-second filter. */
  readonly lastHiddenAt: Date | null;
  readonly events: readonly IncomingEvent[];
}

export interface IntegrityDecision {
  readonly counted: readonly boolean[];
  readonly violationCount: number;
  readonly flagged: boolean;
  readonly action: 'none' | 'warn' | 'auto_submit';
  readonly lastHiddenAt: Date | null;
}

// ---------------------------------------------------------------------------
// Seeded randomness (deterministic per attempt)
// ---------------------------------------------------------------------------

/** mulberry32 — small, fast, deterministic. Not for secrets; only for order. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface AttemptPlan {
  readonly questionIds: readonly string[];
  readonly optionOrder: Readonly<Record<string, readonly string[]>>;
}

/**
 * Decides which questions an attempt gets and in what order, once, at
 * start. Deterministic for a given seed so a resume reproduces the same
 * paper. `questionsPerAttempt` samples a subset AFTER shuffling so the
 * subset differs between attempts; without shuffling it takes the first N
 * in authoring order.
 */
export function buildAttemptPlan(
  questions: readonly Pick<EngineQuestion, 'id' | 'order' | 'options'>[],
  settings: Pick<
    QuizSettingsSnapshot,
    'shuffleQuestions' | 'shuffleOptions' | 'questionsPerAttempt'
  >,
  seed: number,
): AttemptPlan {
  const random = mulberry32(seed);
  const authored = [...questions].sort((a, b) => a.order - b.order);
  const ordered = settings.shuffleQuestions ? seededShuffle(authored, random) : authored;
  const limit =
    settings.questionsPerAttempt !== null && settings.questionsPerAttempt > 0
      ? Math.min(settings.questionsPerAttempt, ordered.length)
      : ordered.length;
  const chosen = ordered.slice(0, limit);
  const optionOrder: Record<string, readonly string[]> = {};
  for (const question of chosen) {
    const ids = question.options.map((option) => option.id);
    optionOrder[question.id] = settings.shuffleOptions ? seededShuffle(ids, random) : ids;
  }
  return { questionIds: chosen.map((question) => question.id), optionOrder };
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function computeDeadline(input: {
  readonly startedAt: Date;
  readonly timeLimitSeconds: number | null;
  readonly timeMultiplier: number;
  readonly availableUntil: Date | null;
}): Date | null {
  const candidates: Date[] = [];
  if (input.timeLimitSeconds !== null && input.timeLimitSeconds > 0) {
    const multiplier = input.timeMultiplier > 0 ? input.timeMultiplier : 1;
    const ms = Math.round(input.timeLimitSeconds * multiplier * 1000);
    candidates.push(new Date(input.startedAt.getTime() + ms));
  }
  if (input.availableUntil) candidates.push(input.availableUntil);
  if (candidates.length === 0) return null;
  return new Date(Math.min(...candidates.map((d) => d.getTime())));
}

export function isPastGrace(deadlineAt: Date | null, now: Date): boolean {
  if (!deadlineAt) return false;
  return now.getTime() > deadlineAt.getTime() + QUIZ_SUBMIT_GRACE_SECONDS * 1000;
}

export function remainingSeconds(deadlineAt: Date | null, now: Date): number | null {
  if (!deadlineAt) return null;
  return Math.max(0, Math.floor((deadlineAt.getTime() - now.getTime()) / 1000));
}

export type WindowState =
  'open' | 'not_yet_open' | 'closed' | 'late_blocked' | 'late_allowed';

/** Whether an attempt may START now, honouring window, due date, late policy and overrides. */
export function resolveWindow(input: {
  readonly now: Date;
  readonly availableFrom: Date | null;
  readonly availableUntil: Date | null;
  readonly dueAt: Date | null;
  readonly latePolicy: AssessmentLatePolicy;
}): WindowState {
  const t = input.now.getTime();
  if (input.availableFrom && t < input.availableFrom.getTime()) return 'not_yet_open';
  if (input.availableUntil && t > input.availableUntil.getTime()) return 'closed';
  if (input.dueAt && t > input.dueAt.getTime()) {
    return input.latePolicy === 'block' ? 'late_blocked' : 'late_allowed';
  }
  return 'open';
}

export function canStartAttempt(
  existingAttemptCount: number,
  maxAttempts: number | null,
  extraAttempts: number,
): boolean {
  if (maxAttempts === null) return true;
  return existingAttemptCount < maxAttempts + Math.max(0, extraAttempts);
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export function normalizeShortAnswer(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function isChoiceType(type: QuizQuestionType): boolean {
  return type === 'single_choice' || type === 'multiple_choice' || type === 'true_false';
}

/**
 * Validates a (possibly partial) answer set against the attempt's own
 * questions. Returns the first error or `null`. Partial coverage is a
 * policy (unanswered = incorrect at grading), never a validation failure.
 */
export function validateAnswers(
  questions: readonly EngineQuestion[],
  answers: readonly AttemptAnswer[],
): AnswerValidationError | null {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question) return 'unknownQuestion';
    if (seen.has(answer.questionId)) return 'duplicateQuestion';
    seen.add(answer.questionId);
    if (isChoiceType(question.type)) {
      if (answer.text !== undefined && answer.text !== null) return 'wrongAnswerShape';
      const selected = answer.selectedOptionIds ?? [];
      const owned = new Set(question.options.map((option) => option.id));
      if (new Set(selected).size !== selected.length) return 'invalidOption';
      if (!selected.every((id) => owned.has(id))) return 'invalidOption';
      if (
        (question.type === 'single_choice' || question.type === 'true_false') &&
        selected.length > 1
      ) {
        return 'invalidOption';
      }
    } else {
      if (answer.selectedOptionIds && answer.selectedOptionIds.length > 0) {
        return 'wrongAnswerShape';
      }
      const text = answer.text ?? '';
      const limit =
        question.type === 'essay' ? MAX_ESSAY_LENGTH : MAX_SHORT_ANSWER_LENGTH;
      if (text.length > limit) return 'textTooLong';
    }
  }
  return null;
}

function isAnswered(
  question: EngineQuestion,
  answer: AttemptAnswer | undefined,
): boolean {
  if (!answer) return false;
  if (isChoiceType(question.type)) return (answer.selectedOptionIds?.length ?? 0) > 0;
  return (answer.text ?? '').trim().length > 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Scores an attempt from its questions, its saved answers and any manual
 * grades. Unanswered questions score zero. Essay questions need a manual
 * grade; until every one has it the attempt is pending and `score` is
 * null. Exact-set scoring for choice questions (no partial credit) —
 * the same rule the Phase 1 scorer applied, now weighted by points.
 */
export function scoreAttempt(
  questions: readonly EngineQuestion[],
  answers: readonly AttemptAnswer[],
  manualGrades: Readonly<Record<string, number>> | null,
): AttemptScore {
  const answerByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  const perQuestion: QuestionScore[] = [];
  let earned = 0;
  let total = 0;
  let pending = false;

  for (const question of questions) {
    const points = Math.max(0, question.points);
    total += points;
    const answer = answerByQuestion.get(question.id);
    const answered = isAnswered(question, answer);

    if (question.type === 'essay') {
      const manual = manualGrades?.[question.id];
      if (typeof manual === 'number' && Number.isFinite(manual)) {
        const awarded = Math.min(points, Math.max(0, manual));
        earned += awarded;
        perQuestion.push({
          questionId: question.id,
          correct: points === 0 ? null : awarded >= points,
          pointsAwarded: awarded,
          pointsPossible: points,
          needsManualGrading: false,
          answered,
        });
      } else {
        if (answered) pending = true;
        perQuestion.push({
          questionId: question.id,
          correct: answered ? null : false,
          pointsAwarded: 0,
          pointsPossible: points,
          needsManualGrading: answered,
          answered,
        });
      }
      continue;
    }

    let correct = false;
    if (answered) {
      if (question.type === 'short_answer') {
        const accepted = (question.acceptedAnswers ?? []).map(normalizeShortAnswer);
        correct = accepted.includes(normalizeShortAnswer(answer?.text ?? ''));
      } else {
        const correctIds = new Set(
          question.options
            .filter((option) => option.isCorrect)
            .map((option) => option.id),
        );
        const selected = new Set(answer?.selectedOptionIds ?? []);
        correct =
          selected.size === correctIds.size &&
          [...correctIds].every((id) => selected.has(id));
      }
    }
    const awarded = correct ? points : 0;
    earned += awarded;
    perQuestion.push({
      questionId: question.id,
      correct,
      pointsAwarded: awarded,
      pointsPossible: points,
      needsManualGrading: false,
      answered,
    });
  }

  const score = pending ? null : total > 0 ? round2((earned / total) * 100) : 0;
  return {
    pointsEarned: round2(earned),
    pointsTotal: round2(total),
    score,
    pendingManual: pending,
    perQuestion,
  };
}

export function isPassing(
  score: number | null,
  passingScore: number | null,
): boolean | null {
  if (score === null) return null;
  return passingScore === null || score >= passingScore;
}

// ---------------------------------------------------------------------------
// Grading policy → the quiz's effective result for a student
// ---------------------------------------------------------------------------

export function aggregateResult(
  policy: QuizGradingPolicy,
  attempts: readonly FinalizedAttemptSummary[],
  passingScore: number | null,
): AggregatedResult {
  const finalized = [...attempts].sort(
    (a, b) =>
      a.submittedAt.getTime() - b.submittedAt.getTime() ||
      a.attemptNumber - b.attemptNumber,
  );
  const scored = finalized.filter(
    (attempt): attempt is FinalizedAttemptSummary & { score: number } =>
      attempt.score !== null && !attempt.pendingGrading,
  );
  const pendingGrading = finalized.some((attempt) => attempt.pendingGrading);
  if (scored.length === 0) {
    return {
      attemptsCount: finalized.length,
      bestScore: null,
      latestScore: null,
      effectiveScore: null,
      effectiveAttemptId: null,
      passed: false,
      pendingGrading,
    };
  }
  const best = scored.reduce((acc, attempt) =>
    attempt.score > acc.score ? attempt : acc,
  );
  const latest = scored[scored.length - 1];
  const first = scored[0];
  let effectiveScore: number;
  let effectiveAttemptId: string | null;
  switch (policy) {
    case 'latest':
      effectiveScore = latest.score;
      effectiveAttemptId = latest.id;
      break;
    case 'first':
      effectiveScore = first.score;
      effectiveAttemptId = first.id;
      break;
    case 'average':
      effectiveScore = round2(
        scored.reduce((sum, attempt) => sum + attempt.score, 0) / scored.length,
      );
      effectiveAttemptId = null;
      break;
    case 'highest':
    default:
      effectiveScore = best.score;
      effectiveAttemptId = best.id;
  }
  return {
    attemptsCount: finalized.length,
    bestScore: best.score,
    latestScore: latest.score,
    effectiveScore,
    effectiveAttemptId,
    passed: isPassing(effectiveScore, passingScore) === true,
    pendingGrading,
  };
}

// ---------------------------------------------------------------------------
// Disclosure
// ---------------------------------------------------------------------------

function disclosureAllows(policy: QuizDisclosure, input: DisclosureInput): boolean {
  switch (policy) {
    case 'immediately':
      return input.attemptFinalized;
    case 'after_due': {
      const gate = input.dueAt ?? input.availableUntil;
      // No due date configured → "after due" can never arrive; treat as
      // after the learner's attempts are exhausted so the answers are
      // not withheld forever by an unset field.
      if (!gate) return exhausted(input);
      return input.attemptFinalized && input.now.getTime() > gate.getTime();
    }
    case 'after_attempts_exhausted':
      return input.attemptFinalized && exhausted(input);
    case 'never':
    default:
      return false;
  }
}

function exhausted(input: DisclosureInput): boolean {
  if (input.maxAttempts === null) return false;
  return input.attemptsUsed >= input.maxAttempts;
}

export function resolveDisclosure(input: DisclosureInput): Disclosure {
  const score = disclosureAllows(input.showScore, input);
  const answers = disclosureAllows(input.showAnswers, input);
  return { score, answers, explanations: answers && input.showExplanations };
}

// ---------------------------------------------------------------------------
// Integrity (detection tier: advisory; escalation only at thresholds)
// ---------------------------------------------------------------------------

const VIOLATION_TYPES: ReadonlySet<QuizAttemptEventType> = new Set<QuizAttemptEventType>([
  'visibility_hidden',
  'blur',
  'fullscreen_exit',
  'copy',
  'paste',
  'cut',
  'contextmenu',
  'print',
  'second_session',
  'device_change',
]);

/**
 * What a browser may attach to an integrity event: a per-type allowlist of
 * keys and values. Anything else a client sends is dropped before it is
 * stored or read — the timeline holds the event, not whatever a modified
 * client chose to put next to it (no device or browsing data, by design).
 */
const EVENT_PAYLOAD_ALLOWLIST: Partial<
  Record<QuizAttemptEventType, Readonly<Record<string, readonly string[]>>>
> = {
  fullscreen_unavailable: { reason: ['unsupported', 'refused'] },
};

export function sanitizeEventPayload(
  type: QuizAttemptEventType,
  payload: Record<string, unknown> | null | undefined,
): Record<string, string> | null {
  const allowed = EVENT_PAYLOAD_ALLOWLIST[type];
  if (!allowed || !payload) return null;
  const kept: Record<string, string> = {};
  for (const [key, values] of Object.entries(allowed)) {
    const value = payload[key];
    if (typeof value === 'string' && values.includes(value)) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

export function decideIntegrity(input: IntegrityDecisionInput): IntegrityDecision {
  const counted: boolean[] = [];
  let violationCount = input.violationCount;
  let lastHiddenAt = input.lastHiddenAt;
  const lastCountedAt = new Map(input.lastCountedAt);
  const warmUpUntil = input.startedAt.getTime() + INTEGRITY_WARM_UP_MS;

  for (const event of input.events) {
    const at = input.now;
    let counts = false;
    if (
      input.mode !== 'off' &&
      VIOLATION_TYPES.has(event.type) &&
      at.getTime() >= warmUpUntil
    ) {
      const last = lastCountedAt.get(event.type);
      const debounced =
        last !== undefined && at.getTime() - last.getTime() < INTEGRITY_DEBOUNCE_MS;
      counts = !debounced;
    }
    if (event.type === 'visibility_hidden') lastHiddenAt = at;
    if (event.type === 'visibility_visible' && lastHiddenAt) {
      // A hidden→visible flicker under one second is not a tab switch:
      // uncount the hidden event it pairs with.
      if (at.getTime() - lastHiddenAt.getTime() < INTEGRITY_SUB_SECOND_MS) {
        const hiddenIndex = counted.length - 1;
        if (
          hiddenIndex >= 0 &&
          input.events[hiddenIndex]?.type === 'visibility_hidden' &&
          counted[hiddenIndex]
        ) {
          counted[hiddenIndex] = false;
          violationCount = Math.max(input.violationCount, violationCount - 1);
          lastCountedAt.delete('visibility_hidden');
        }
      }
      lastHiddenAt = null;
    }
    if (counts) {
      violationCount += 1;
      lastCountedAt.set(event.type, at);
    }
    counted.push(counts);
  }

  const flagged = input.mode !== 'off' && violationCount > 0;
  let action: IntegrityDecision['action'] = 'none';
  const newlyCounted = counted.some(Boolean);
  if (newlyCounted && (input.mode === 'warn' || input.mode === 'strict')) {
    action = 'warn';
    if (input.mode === 'strict' && violationCount >= Math.max(1, input.maxViolations)) {
      action = 'auto_submit';
    }
  }
  return { counted, violationCount, flagged, action, lastHiddenAt };
}

/** Learner-facing projection of the settings that matter during an attempt. */
export function attemptSettingsForLearner(snapshot: QuizSettingsSnapshot): {
  readonly mode: QuizMode;
  readonly layout: QuizLayout;
  readonly hideTimer: boolean;
  readonly integrityMode: QuizIntegrityMode;
  readonly maxViolations: number;
  readonly requireFullscreen: boolean;
  readonly timeLimitSeconds: number | null;
  readonly timeMultiplier: number;
} {
  return {
    mode: snapshot.mode,
    layout: snapshot.layout,
    hideTimer: snapshot.hideTimer,
    integrityMode: snapshot.integrityMode,
    maxViolations: snapshot.maxViolations,
    requireFullscreen: snapshot.requireFullscreen,
    timeLimitSeconds: snapshot.timeLimitSeconds,
    timeMultiplier: snapshot.timeMultiplier,
  };
}
