/**
 * P64 Phase 3 — maps the authoring DTO's optional settings onto Prisma
 * write data (only the fields the author actually sent) and validates the
 * cross-field rules the column types cannot express.
 */
import { BadRequestException } from '@nestjs/common';
import type { QuizSettingsFieldsDto } from './quiz-settings.dto';
import { toDateOrNull } from './quiz-settings.dto';
import type { QuizSettingsWriteData } from '../repositories/quizzes.repository';

export function settingsWriteDataFromDto(
  dto: QuizSettingsFieldsDto,
): QuizSettingsWriteData {
  const out: Record<string, unknown> = {};
  const scalar = <K extends keyof QuizSettingsFieldsDto>(key: K): void => {
    if (dto[key] !== undefined) out[key] = dto[key];
  };
  scalar('mode');
  scalar('timeLimitSeconds');
  scalar('latePolicy');
  scalar('gradingPolicy');
  scalar('shuffleQuestions');
  scalar('shuffleOptions');
  scalar('questionsPerAttempt');
  scalar('layout');
  scalar('showScore');
  scalar('showAnswers');
  scalar('showExplanations');
  scalar('integrityMode');
  scalar('maxViolations');
  scalar('requireFullscreen');
  scalar('requiredToProgress');
  scalar('requiredForCompletion');
  scalar('hideTimer');
  const availableFrom = toDateOrNull(dto.availableFrom);
  if (availableFrom !== undefined) out.availableFrom = availableFrom;
  const availableUntil = toDateOrNull(dto.availableUntil);
  if (availableUntil !== undefined) out.availableUntil = availableUntil;
  const dueAt = toDateOrNull(dto.dueAt);
  if (dueAt !== undefined) out.dueAt = dueAt;
  return out as QuizSettingsWriteData;
}

/**
 * Validates the effective settings (current row merged with the update),
 * so an update that only moves one date is still checked against the
 * other. `questionCount` is the size of the question set the quiz will
 * hold after this write.
 */
export function assertValidQuizSettings(
  effective: {
    readonly availableFrom: Date | null;
    readonly availableUntil: Date | null;
    readonly dueAt: Date | null;
    readonly questionsPerAttempt: number | null;
    readonly timeLimitSeconds: number | null;
    readonly mode: string;
  },
  questionCount: number,
): void {
  if (
    effective.availableFrom &&
    effective.availableUntil &&
    effective.availableFrom.getTime() >= effective.availableUntil.getTime()
  ) {
    throw new BadRequestException({
      messageKey: 'errors.quiz.windowOrder',
      // W7 — name the field, so the authoring form shows the error ON it
      // (and opens the collapsed "Advanced options" that holds it).
      violations: [{ field: 'availableUntil', messageKey: 'errors.quiz.windowOrder' }],
    });
  }
  if (
    effective.dueAt &&
    effective.availableUntil &&
    effective.dueAt.getTime() > effective.availableUntil.getTime()
  ) {
    throw new BadRequestException({
      messageKey: 'errors.quiz.dueAfterWindow',
      violations: [{ field: 'dueAt', messageKey: 'errors.quiz.dueAfterWindow' }],
    });
  }
  if (
    effective.questionsPerAttempt !== null &&
    effective.questionsPerAttempt > questionCount
  ) {
    throw new BadRequestException({
      messageKey: 'errors.quiz.questionsPerAttemptExceedsCount',
      details: { questionCount },
      violations: [
        {
          field: 'questionsPerAttempt',
          messageKey: 'errors.quiz.questionsPerAttemptExceedsCount',
          values: { questionCount },
        },
      ],
    });
  }
}

/**
 * The quiz settings that only take effect behind a rollout flag
 * (`quiz-attempt-engine.service.ts`'s `start`): with `quiz.engine_v2` off
 * an attempt has no time limit, nothing shuffled, every question on one
 * page; with `quiz.integrity` off (or engine v2 off) integrity and full
 * screen are not applied. Each entry is the field's "does nothing" value.
 */
const ENGINE_V2_SETTINGS = {
  timeLimitSeconds: null,
  shuffleQuestions: false,
  shuffleOptions: false,
  questionsPerAttempt: null,
  layout: 'all_questions',
} as const;
const INTEGRITY_SETTINGS = {
  integrityMode: 'off',
  requireFullscreen: false,
} as const;

/**
 * Refuses to SAVE a setting the academy's attempts would silently ignore
 * (flag off for this academy), instead of storing it and running the quiz
 * without it. The frontend has no per-academy view of these flags, so an
 * honest refusal on the field is how the author learns it is unavailable.
 *
 * Only a value the author is CHANGING to something other than the
 * "does nothing" value is refused: a quiz saved while the flag was on can
 * still be edited (title, questions…) after it is switched off, and
 * clearing the setting is always allowed. `existing` is the stored row
 * (`null` on create, where every field starts at its default).
 */
export function assertQuizSettingsAvailable(
  settings: QuizSettingsWriteData,
  existing: Readonly<Record<string, unknown>> | null,
  available: { readonly engineV2: boolean; readonly integrity: boolean },
): void {
  const refused: string[] = [];
  const check = (defaults: Readonly<Record<string, unknown>>, on: boolean) => {
    if (on) return;
    for (const [field, inert] of Object.entries(defaults)) {
      const next = (settings as Record<string, unknown>)[field];
      if (next === undefined || next === inert) continue;
      const current = existing ? existing[field] : inert;
      if (next === current) continue;
      refused.push(field);
    }
  };
  check(ENGINE_V2_SETTINGS, available.engineV2);
  check(INTEGRITY_SETTINGS, available.engineV2 && available.integrity);
  if (refused.length === 0) return;
  throw new BadRequestException({
    messageKey: 'errors.validation.failed',
    violations: refused.map((field) => ({
      field,
      messageKey: 'errors.quiz.settingUnavailable',
    })),
  });
}
