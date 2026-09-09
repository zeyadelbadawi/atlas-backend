/**
 * `UserSession` response contract — one active device session
 * (Phase 10, Decision 7).
 *
 * WHAT IS DELIBERATELY ABSENT, and must stay absent. This response is
 * returned to a browser, so it carries no authentication material of any
 * kind: no `tokenHash`, no refresh token, no access token, no password
 * hash, and not even the refresh-token ROW id. The only identifier is
 * `sessionId`, which is exactly the handle `DELETE /auth/sessions/:id`
 * needs and is useless for authenticating anything — knowing it lets you
 * revoke a session you already own, nothing more.
 *
 * `userId` is absent too: every row belongs to the caller by
 * construction, so echoing it back would add no information and only
 * invite a client to start keying off it.
 *
 * HONESTY. `ipAddress`, `userAgent`, `deviceLabel` and `lastUsedAt` are
 * all optional because sessions created before Phase 10 genuinely have
 * none recorded. They are omitted rather than filled with "Unknown
 * device", the server's own address, or `createdAt` reused as activity —
 * the UI renders an explicit unknown state instead of a plausible-looking
 * fiction.
 */
import type { SessionSummaryRow } from '../repositories/refresh-tokens.repository';
import { deriveDeviceLabel } from '../utils/request-metadata.util';

export interface UserSessionResponse {
  /** The stable device-session id — the handle `DELETE /auth/sessions/:id` accepts. Never a token or a refresh-token row id. */
  readonly id: string;
  /** A coarse, server-derived label such as "Chrome on macOS". Absent when no user agent was recorded or none could be recognised. */
  readonly deviceLabel?: string;
  /** The raw user agent, for a user who wants the precise detail behind the label. */
  readonly userAgent?: string;
  readonly ipAddress?: string;
  /** When the user actually signed in on this device — the first row of the rotation family, not the latest rotation. */
  readonly startedAt: string;
  /** Real last activity: sign-in, or the most recent token refresh. */
  readonly lastUsedAt?: string;
  readonly expiresAt: string;
  /** True for the session making this very request, so the UI can label it and treat revoking it as signing out. */
  readonly isCurrent: boolean;
}

export function toUserSessionResponse(
  row: SessionSummaryRow,
  currentSessionId: string,
): UserSessionResponse {
  return {
    id: row.sessionId,
    // Prefer the label stored at sign-in; fall back to deriving one from
    // the stored agent so rows written before labels were persisted still
    // display usefully. Still `undefined` when neither exists.
    deviceLabel: row.deviceLabel ?? deriveDeviceLabel(row.userAgent ?? undefined),
    userAgent: row.userAgent ?? undefined,
    ipAddress: row.ipAddress ?? undefined,
    startedAt: row.startedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    isCurrent: row.sessionId === currentSessionId,
  };
}
