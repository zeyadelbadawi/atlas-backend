/**
 * The academy build screen's PRESENTED window — and when "your academy is
 * ready" may be told.
 *
 * Real provisioning finishes in seconds, but the owner watches a build
 * screen that deliberately runs longer (45–75 s, see the frontend's
 * `AcademyBuildExperience`). The ready email used to go out when the real
 * work finished, so it landed in the owner's inbox while the screen still
 * showed ~30 %. The server now owns that window:
 *
 *   - each request gets a presented duration in [MIN, MAX], derived
 *     deterministically from its id (no stored column, the same answer on
 *     every read and every retry);
 *   - `presentedReadyAt = createdAt + duration` is returned on the request
 *     (`ProvisioningRequestResponse.presentedReadyAt`), and the frontend
 *     drives its progress to 100 % at exactly that instant;
 *   - the ready email's outbox row is made available at
 *     `max(presentedReadyAt, real completion)` — never before the academy
 *     really exists, never before the screen says 100 %.
 *
 * MIRRORED in the frontend: `ACADEMY_BUILD_MIN_MS`/`ACADEMY_BUILD_MAX_MS`
 * in `atlas-front/src/shared/components/academy-build/academy-build-timer.ts`
 * (the frontend's validation bounds and its fallback when an older API
 * returns no `presentedReadyAt`). A spec on each side pins the values, so
 * changing one without the other fails a test.
 */
import { createHash } from 'node:crypto';

export const PRESENTED_BUILD_MIN_MS = 45_000;
export const PRESENTED_BUILD_MAX_MS = 75_000;

/** The presented build duration of one request: stable per id, within [MIN, MAX]. */
export function presentedBuildDurationMs(requestId: string): number {
  const digest = createHash('sha256').update(requestId).digest();
  const fraction = digest.readUInt32BE(0) / 0x1_0000_0000;
  return Math.round(
    PRESENTED_BUILD_MIN_MS + fraction * (PRESENTED_BUILD_MAX_MS - PRESENTED_BUILD_MIN_MS),
  );
}

/** The instant the build screen reaches 100 % for this request. */
export function presentedReadyAt(request: {
  readonly id: string;
  readonly createdAt: Date;
}): Date {
  return new Date(request.createdAt.getTime() + presentedBuildDurationMs(request.id));
}
