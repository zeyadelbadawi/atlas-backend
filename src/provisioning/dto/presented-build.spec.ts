import {
  PRESENTED_BUILD_MAX_MS,
  PRESENTED_BUILD_MIN_MS,
  presentedBuildDurationMs,
  presentedReadyAt,
} from './presented-build';

describe('presented build window (the ready email waits for the 100 %)', () => {
  it('pins the window the frontend build screen also uses (keep in step with academy-build-timer.ts)', () => {
    // MIRRORED: ACADEMY_BUILD_MIN_MS / ACADEMY_BUILD_MAX_MS in
    // atlas-front/src/shared/components/academy-build/academy-build-timer.ts.
    // Changing these alone fails this test on purpose.
    expect(PRESENTED_BUILD_MIN_MS).toBe(45_000);
    expect(PRESENTED_BUILD_MAX_MS).toBe(75_000);
  });

  it('gives each request a stable duration inside the window', () => {
    const durations = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const duration = presentedBuildDurationMs(id);
      expect(duration).toBeGreaterThanOrEqual(PRESENTED_BUILD_MIN_MS);
      expect(duration).toBeLessThanOrEqual(PRESENTED_BUILD_MAX_MS);
      // Same id, same answer — on every read, poll and retry.
      expect(presentedBuildDurationMs(id)).toBe(duration);
      durations.add(duration);
    }
    // Not one fixed value: the window still varies between requests.
    expect(durations.size).toBeGreaterThan(50);
  });

  it('places the 100 % at createdAt + the request’s duration', () => {
    const createdAt = new Date('2026-11-06T10:00:00.000Z');
    const readyAt = presentedReadyAt({ id: 'req-1', createdAt });
    expect(readyAt.getTime() - createdAt.getTime()).toBe(
      presentedBuildDurationMs('req-1'),
    );
  });
});
