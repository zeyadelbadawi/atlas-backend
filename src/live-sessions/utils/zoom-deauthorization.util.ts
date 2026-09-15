/**
 * Extracts the few fields Atlas needs from a Zoom deauthorization body.
 *
 * SEPARATE FROM `zoom-event.util.ts` ON PURPOSE. That extractor is
 * meeting-shaped: it reads `payload.object.id` and derives an event
 * identity from a meeting and a participant. A deauthorization payload
 * has no `payload.object` at all — it is account-shaped — so running it
 * through the meeting extractor yields an event with no meeting id, which
 * the queue processor discards as `unmatched`. Two different payload
 * shapes, two parsers, neither pretending to be the other.
 *
 * TOTAL AND DEFENSIVE, like its sibling: every field is checked, and
 * anything unexpected returns `null` rather than throwing. A malformed
 * body must be a refusal, never a 500 that tells a prober they found a
 * code path.
 *
 * WHAT IS DELIBERATELY NOT RETURNED: `payload.signature`. Zoom includes a
 * per-payload signature field that predates the app-level Secret Token
 * scheme; Atlas verifies the `x-zm-signature` HEADER instead, which is
 * the mechanism Zoom's current webhook guidance documents and the one the
 * meeting webhook already uses. Parsing a second, weaker signature into
 * the domain would invite somebody to trust it later.
 */

/** Zoom's event name for a customer removing the Atlas app. */
export const ZOOM_DEAUTHORIZATION_EVENT = 'app_deauthorized';

export interface ExtractedZoomDeauthorization {
  /** The Zoom ACCOUNT that removed the app — Atlas's tenant bridge. */
  readonly accountId: string;
  /** Which Zoom application was removed. Checked against Atlas's own. */
  readonly clientId: string;
  /** The Zoom user who performed it. Recorded for audit only. */
  readonly zoomUserId?: string;
  /**
   * When Zoom says the authorization ended.
   *
   * REQUIRED, not optional, because it is what makes a stale redelivery
   * distinguishable from a live one. Without it a notification that
   * arrives after the customer has already reconnected cannot be told
   * apart from one that arrives before — so a missing or unparseable
   * value is treated as malformed rather than defaulted to "now", which
   * would silently disarm that protection.
   */
  readonly deauthorizedAt: Date;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function extractZoomDeauthorization(
  body: unknown,
): ExtractedZoomDeauthorization | null {
  const root = asRecord(body);
  if (!root) return null;
  if (asString(root.event) !== ZOOM_DEAUTHORIZATION_EVENT) return null;

  const payload = asRecord(root.payload);
  if (!payload) return null;

  const accountId = asString(payload.account_id);
  const clientId = asString(payload.client_id);
  if (!accountId || !clientId) return null;

  const rawTime = asString(payload.deauthorization_time);
  if (!rawTime) return null;
  const deauthorizedAt = new Date(rawTime);
  if (Number.isNaN(deauthorizedAt.getTime())) return null;

  return {
    accountId,
    clientId,
    zoomUserId: asString(payload.user_id),
    deauthorizedAt,
  };
}
