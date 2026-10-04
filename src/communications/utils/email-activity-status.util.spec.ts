/** W3 — raw reasons and provider text map to a closed category, never through. */
import {
  EMAIL_ERROR_CATEGORIES,
  categorizeEmailError,
} from './email-activity-status.util';

const c = (
  lastError: string | null,
  deliveryStatus: string | null = null,
  code: string | null = null,
) => categorizeEmailError({ lastError, deliveryStatus, deliveryErrorCode: code });

describe('categorizeEmailError', () => {
  it('maps Atlas reason codes', () => {
    expect(c('preference_off')).toBe('recipient_preference');
    expect(c('daily_cap')).toBe('daily_limit');
    expect(c('address_suppressed')).toBe('address_suppressed');
    expect(c('recipient_unavailable')).toBe('recipient_unavailable');
    expect(c('no_recipient')).toBe('recipient_unavailable');
    expect(c('source_deleted')).toBe('source_deleted');
    expect(c('unknown_key:foo.bar')).toBe('configuration');
  });

  it('maps provider output by HTTP class and quota', () => {
    expect(c('brevo: HTTP 400 (invalid_parameter)')).toBe('provider_rejected');
    expect(c('resend: HTTP 503')).toBe('provider_unavailable');
    expect(c('brevo: HTTP 429 (too_many_requests)')).toBe('quota');
    expect(c('No email provider had quota available for this category.')).toBe('quota');
    expect(c('fetch failed: ECONNRESET')).toBe('provider_unavailable');
  });

  it('webhook outcomes win, and raw MTA text (which can quote the address) never passes through', () => {
    const mta = '550 5.1.1 <someone@example.com>: Recipient address rejected';
    expect(c(null, 'bounced', mta)).toBe('bounce_hard');
    expect(c(null, 'deferred', mta)).toBe('bounce_soft');
    expect(c(null, 'complained', mta)).toBe('complaint');
    expect(c(mta)).toBe('unknown');
    for (const value of [c(mta), c(null, 'bounced', mta)]) {
      expect(EMAIL_ERROR_CATEGORIES).toContain(value);
      expect(String(value)).not.toContain('@');
    }
  });

  it('reports no error for a clean row', () => {
    expect(c(null, 'sent')).toBeNull();
    expect(c(null, 'delivered')).toBeNull();
    expect(c(null, 'failed')).toBe('unknown');
  });
});
