/**
 * P64 Phase 1 — the one rule for "this enrollment grants access right now".
 * Every reader (content, quizzes, assignments, progress, roster) shares it,
 * so it is unit-tested directly rather than only through HTTP.
 */
import { isEnrollmentActive } from './learning-access.util';

const base = {
  status: 'enrolled' as const,
  revokedAt: null as Date | null,
  expiresAt: null as Date | null,
};

describe('isEnrollmentActive (P64 Phase 1)', () => {
  it('accepts an enrolled or completed enrollment with no lifecycle limits', () => {
    expect(isEnrollmentActive(base)).toBe(true);
    expect(isEnrollmentActive({ ...base, status: 'completed' })).toBe(true);
  });

  it('refuses every non-active status', () => {
    for (const status of ['available', 'pending', 'unavailable'] as const) {
      expect(isEnrollmentActive({ ...base, status })).toBe(false);
    }
  });

  it('refuses a revoked enrollment even when the status still says enrolled', () => {
    expect(isEnrollmentActive({ ...base, revokedAt: new Date() })).toBe(false);
  });

  it('refuses an expired enrollment and accepts one expiring in the future', () => {
    const now = new Date('2026-09-18T12:00:00.000Z');
    expect(
      isEnrollmentActive(
        { ...base, expiresAt: new Date('2026-09-18T11:59:59.000Z') },
        now,
      ),
    ).toBe(false);
    expect(
      isEnrollmentActive(
        { ...base, expiresAt: new Date('2026-09-18T12:00:01.000Z') },
        now,
      ),
    ).toBe(true);
  });

  it('treats an expiry exactly at "now" as expired — access ends at the boundary', () => {
    const now = new Date('2026-09-18T12:00:00.000Z');
    expect(isEnrollmentActive({ ...base, expiresAt: now }, now)).toBe(false);
  });
});
