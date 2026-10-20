import { BadRequestException } from '@nestjs/common';
import { assertQuizSettingsAvailable } from './quiz-settings.mapper';
import type { QuizSettingsWriteData } from '../repositories/quizzes.repository';

const ALL_ON = { engineV2: true, integrity: true };
const ENGINE_OFF = { engineV2: false, integrity: true };
const INTEGRITY_OFF = { engineV2: true, integrity: false };

function refusedFields(
  settings: Record<string, unknown>,
  existing: Record<string, unknown> | null,
  available: { engineV2: boolean; integrity: boolean },
): string[] {
  try {
    assertQuizSettingsAvailable(settings as QuizSettingsWriteData, existing, available);
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as {
      messageKey: string;
      violations: { field: string; messageKey: string }[];
    };
    expect(body.messageKey).toBe('errors.validation.failed');
    for (const violation of body.violations) {
      expect(violation.messageKey).toBe('errors.quiz.settingUnavailable');
    }
    return body.violations.map((violation) => violation.field);
  }
}

describe('assertQuizSettingsAvailable', () => {
  it('accepts every setting while both flags are on', () => {
    expect(
      refusedFields(
        {
          timeLimitSeconds: 600,
          shuffleQuestions: true,
          shuffleOptions: true,
          questionsPerAttempt: 2,
          layout: 'one_per_page',
          integrityMode: 'strict',
          requireFullscreen: true,
        },
        null,
        ALL_ON,
      ),
    ).toEqual([]);
  });

  it('refuses a new time limit, shuffle, subset and layout when engine v2 is off — and integrity with it', () => {
    expect(
      refusedFields(
        {
          timeLimitSeconds: 600,
          shuffleQuestions: true,
          shuffleOptions: true,
          questionsPerAttempt: 2,
          layout: 'one_per_page',
          integrityMode: 'warn',
          requireFullscreen: true,
        },
        null,
        ENGINE_OFF,
      ),
    ).toEqual([
      'timeLimitSeconds',
      'shuffleQuestions',
      'shuffleOptions',
      'questionsPerAttempt',
      'layout',
      'integrityMode',
      'requireFullscreen',
    ]);
  });

  it('refuses only integrity and full screen when just the integrity flag is off', () => {
    expect(
      refusedFields(
        { timeLimitSeconds: 600, integrityMode: 'monitor', requireFullscreen: true },
        null,
        INTEGRITY_OFF,
      ),
    ).toEqual(['integrityMode', 'requireFullscreen']);
  });

  it('always accepts the "does nothing" values, so a setting can be cleared', () => {
    expect(
      refusedFields(
        {
          timeLimitSeconds: null,
          shuffleQuestions: false,
          shuffleOptions: false,
          questionsPerAttempt: null,
          layout: 'all_questions',
          integrityMode: 'off',
          requireFullscreen: false,
          // Not flag-gated at all.
          gradingPolicy: 'latest',
          showAnswers: 'immediately',
        },
        { timeLimitSeconds: 600, shuffleQuestions: true, integrityMode: 'warn' },
        ENGINE_OFF,
      ),
    ).toEqual([]);
  });

  it('lets a quiz saved while the flag was on be re-saved unchanged after it is switched off', () => {
    const stored = {
      timeLimitSeconds: 600,
      shuffleQuestions: true,
      integrityMode: 'warn',
    };
    expect(refusedFields({ ...stored }, stored, ENGINE_OFF)).toEqual([]);
    // …but CHANGING it to another non-default value is refused.
    expect(refusedFields({ timeLimitSeconds: 900 }, stored, ENGINE_OFF)).toEqual([
      'timeLimitSeconds',
    ]);
  });
});
