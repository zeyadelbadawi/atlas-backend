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
    throw new BadRequestException({ messageKey: 'errors.quiz.windowOrder' });
  }
  if (
    effective.dueAt &&
    effective.availableUntil &&
    effective.dueAt.getTime() > effective.availableUntil.getTime()
  ) {
    throw new BadRequestException({ messageKey: 'errors.quiz.dueAfterWindow' });
  }
  if (
    effective.questionsPerAttempt !== null &&
    effective.questionsPerAttempt > questionCount
  ) {
    throw new BadRequestException({
      messageKey: 'errors.quiz.questionsPerAttemptExceedsCount',
      details: { questionCount },
    });
  }
}
