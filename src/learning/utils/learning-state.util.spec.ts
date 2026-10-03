import { deriveLearningState } from './learning-state.util';

describe('deriveLearningState', () => {
  it('no progress row, nothing done, no activity: not started', () => {
    expect(deriveLearningState(undefined)).toBe('not_started');
    expect(
      deriveLearningState({
        completionState: 'incomplete',
        completedItems: 0,
        completedLessons: 0,
        lastActivityAt: null,
      }),
    ).toBe('not_started');
  });

  it('watching part of a lesson is a start, though nothing is finished', () => {
    expect(
      deriveLearningState({
        completionState: 'incomplete',
        completedItems: 0,
        lastActivityAt: new Date(),
      }),
    ).toBe('in_progress');
  });

  it('a finished item, or the completion rule saying so, is in progress', () => {
    expect(
      deriveLearningState({ completionState: 'incomplete', completedItems: 1 }),
    ).toBe('in_progress');
    expect(deriveLearningState({ completionState: 'in_progress' })).toBe('in_progress');
  });

  it('completed wins', () => {
    expect(
      deriveLearningState({
        completionState: 'completed',
        completedItems: 3,
        lastActivityAt: new Date(),
      }),
    ).toBe('completed');
  });
});
