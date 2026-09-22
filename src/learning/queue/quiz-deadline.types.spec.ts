import { quizDeadlineJobId } from './quiz-deadline.types';

/**
 * BullMQ (5.x) throws "Custom Id cannot contain :" for a custom job id with
 * a colon unless it happens to have exactly three segments. A two-segment
 * id silently disabled the whole delayed auto-submit path in production
 * (22 Sep 2026) because the producer treats scheduling as best effort.
 */
describe('quizDeadlineJobId', () => {
  it('is stable per attempt and never contains a colon', () => {
    const id = quizDeadlineJobId('a7b17e99-0783-447f-b13f-cedc3f79baa0');
    expect(id).toBe('quiz-deadline-a7b17e99-0783-447f-b13f-cedc3f79baa0');
    expect(id).not.toContain(':');
    expect(quizDeadlineJobId('x')).toBe(quizDeadlineJobId('x'));
  });
});
