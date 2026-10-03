/**
 * W3 — the honest vocabulary of the Platform Owner's Academy Email Activity
 * page, and the closed error categories it shows instead of raw provider
 * text.
 *
 * WHY CATEGORIES, NOT TEXT. `communication_outbox.last_error` and
 * `communication_deliveries.error_code` hold either Atlas's own reason codes
 * (`preference_off`, `address_suppressed`, …) or provider output
 * (`brevo: HTTP 400 (invalid_parameter)`, a webhook bounce reason). Webhook
 * reasons are raw MTA text that can quote the recipient's address, so the
 * page never shows either column: each maps to exactly one category here,
 * and anything unrecognised becomes `unknown` rather than leaking through.
 *
 * WHY "DISPATCHED" IS NOT "SENT". The outbox settles in-app-only,
 * preference-off and daily-cap rows as `dispatched` too
 * (investigation W3a §1.3). The status below is derived from the outbox
 * state AND the latest email delivery row, so "Sent to provider",
 * "Delivered" (webhook-confirmed) and "Not sent" stay distinct.
 */

/** UI statuses, in the order the page lists them. */
export const EMAIL_ACTIVITY_STATUSES = [
  'queued',
  'retrying',
  'waiting',
  'sent',
  'delivered',
  'delayed',
  'bounced',
  'complained',
  'not_sent',
  'in_app_only',
  'suppressed',
  'failed',
] as const;
export type EmailActivityStatus = (typeof EMAIL_ACTIVITY_STATUSES)[number];

/** Closed error categories — the only error information the page carries. */
export const EMAIL_ERROR_CATEGORIES = [
  'recipient_preference',
  'daily_limit',
  'address_suppressed',
  'recipient_unavailable',
  'source_deleted',
  'configuration',
  'quota',
  'provider_rejected',
  'provider_unavailable',
  'bounce_hard',
  'bounce_soft',
  'complaint',
  'unknown',
] as const;
export type EmailErrorCategory = (typeof EMAIL_ERROR_CATEGORIES)[number];

/**
 * The SQL expression the status is derived with — ONE definition, used by
 * the list, its filter and the summary, so they can never disagree. `o` is
 * the outbox row, `d` the latest email delivery row (LEFT JOIN LATERAL).
 */
export const EMAIL_ACTIVITY_STATUS_SQL = `CASE
  WHEN o."state" = 'pending' AND o."attempts" = 0 THEN 'queued'
  WHEN o."state" = 'pending' THEN 'retrying'
  WHEN o."state" = 'deferred' THEN 'waiting'
  WHEN o."state" = 'failed' THEN 'failed'
  WHEN o."state" = 'suppressed' THEN 'suppressed'
  WHEN d."status" = 'delivered' THEN 'delivered'
  WHEN d."status" = 'deferred' THEN 'delayed'
  WHEN d."status" = 'bounced' THEN 'bounced'
  WHEN d."status" = 'complained' THEN 'complained'
  WHEN d."status" = 'failed' THEN 'failed'
  WHEN d."status" = 'sent' THEN 'sent'
  WHEN d."status" = 'suppressed' OR o."last_error" IN ('preference_off', 'daily_cap') THEN 'not_sent'
  ELSE 'in_app_only'
END`;

/**
 * Maps a row's raw reason/error text and delivery status to one category,
 * or `null` when the row has no error to report. Never returns the input.
 */
export function categorizeEmailError(input: {
  readonly lastError: string | null;
  readonly deliveryStatus: string | null;
  readonly deliveryErrorCode: string | null;
}): EmailErrorCategory | null {
  const { deliveryStatus } = input;
  if (deliveryStatus === 'bounced') return 'bounce_hard';
  if (deliveryStatus === 'deferred') return 'bounce_soft';
  if (deliveryStatus === 'complained') return 'complaint';

  const reason = (input.lastError ?? input.deliveryErrorCode ?? '').trim();
  if (!reason) return deliveryStatus === 'failed' ? 'unknown' : null;
  switch (reason) {
    case 'preference_off':
      return 'recipient_preference';
    case 'daily_cap':
      return 'daily_limit';
    case 'address_suppressed':
      return 'address_suppressed';
    case 'recipient_unavailable':
    case 'no_recipient':
      return 'recipient_unavailable';
    case 'source_deleted':
      return 'source_deleted';
    case 'unknown_key':
      return 'configuration';
    default:
      break;
  }
  if (reason.startsWith('unknown_key:')) return 'configuration';
  const lower = reason.toLowerCase();
  if (
    lower.includes('quota') ||
    lower.includes('rate limit') ||
    lower.includes('http 429')
  ) {
    return 'quota';
  }
  const http = /http (\d{3})/.exec(lower);
  if (http) {
    const status = Number(http[1]);
    if (status >= 500) return 'provider_unavailable';
    if (status >= 400) return 'provider_rejected';
  }
  if (/timeout|timed out|econn|enotfound|network|fetch failed|socket/.test(lower)) {
    return 'provider_unavailable';
  }
  return 'unknown';
}

/** Catalogue keys whose email is a credential: listed, but never with more than status. */
export const SECURITY_EMAIL_KEYS: ReadonlySet<string> = new Set([
  'auth.email.otp',
  'auth.account.deletion_code',
  'auth.email.verification',
  'auth.password.reset',
  'academy.member.invited',
  'academy.learner.invited',
]);
