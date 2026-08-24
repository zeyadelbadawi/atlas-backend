import {
  deriveCertificateStatus,
  deriveCompletionState,
} from './progress-computation.util';

describe('deriveCompletionState', () => {
  it('is incomplete when nothing is completed', () => {
    expect(deriveCompletionState(0, 5)).toBe('incomplete');
  });

  it('is in_progress when some but not all lessons are completed', () => {
    expect(deriveCompletionState(2, 5)).toBe('in_progress');
  });

  it('is completed when every lesson is completed', () => {
    expect(deriveCompletionState(5, 5)).toBe('completed');
  });

  it('is incomplete (not completed) for a course with zero published lessons', () => {
    // A trivial 0-of-0 "completion" would show a nonsensical "course
    // complete" congratulations for a course with no actual content.
    expect(deriveCompletionState(0, 0)).toBe('incomplete');
  });
});

describe('deriveCertificateStatus', () => {
  it('is eligible only when completionState is completed', () => {
    expect(deriveCertificateStatus('completed')).toBe('eligible');
  });

  it('is unavailable for in_progress', () => {
    expect(deriveCertificateStatus('in_progress')).toBe('unavailable');
  });

  it('is unavailable for incomplete', () => {
    expect(deriveCertificateStatus('incomplete')).toBe('unavailable');
  });
});
