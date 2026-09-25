/**
 * ResendEmailProvider — FALLBACK transactional-email adapter (owner
 * decision, P64 Communications; P17 originally shipped it as the only
 * real provider). `POST https://api.resend.com/emails`, Bearer key, Node
 * 20 `fetch` only; sends `Idempotency-Key` when the caller supplies one.
 *
 * NOT YET IN THE PRODUCTION CHAIN. Production runs `EMAIL_PROVIDERS=brevo`
 * because Resend refuses to send from an unverified domain and Atlas has
 * no verified Resend sending domain yet. Everything in this file is built
 * so that adding `resend` to that list is a configuration change with no
 * code left to write — but NOTHING here has been exercised against the
 * live Resend API, and real delivery stays UNVERIFIED until the domain
 * exists.
 *
 * Outbound shape (Resend's documented REST contract):
 *   - `from` is `Display Name <address>`; the display name is quoted when
 *     it contains RFC 5322 specials, or Resend rejects it 422.
 *   - `reply_to` is the REST field name (the Node SDK's `replyTo` is an
 *     SDK-side alias and is NOT accepted on the wire).
 *   - `tags` are `{ name, value }` pairs and BOTH sides accept only
 *     `[A-Za-z0-9_-]`. Atlas's own convention is `key:value` strings
 *     (`EmailTransport.flattenTags`), whose `:` and `.` are both outside
 *     that set — so tags are split and sanitised here rather than passed
 *     through, which would make every outbox email a 422.
 *   - `Idempotency-Key` is capped at 256 characters; a longer key is
 *     replaced by a stable digest of itself so idempotency survives.
 *
 * Inbound: Resend webhooks are signed by Svix — `svix-id`,
 * `svix-timestamp`, `svix-signature` (`v1,<base64>` entries, space
 * separated; the unbranded `webhook-*` aliases are accepted too). The
 * signed content is `${id}.${timestamp}.${rawBody}` under HMAC-SHA256
 * with the secret after the `whsec_` prefix (base64-decoded), compared
 * constant-time. A five-minute timestamp tolerance rejects replays, and
 * an unset `RESEND_WEBHOOK_SECRET` fails closed.
 *
 * Never logs addresses, API keys or message content.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { EmailConfig } from '../../config/configuration';
import { EmailProviderError } from '../../identity/services/email-provider.interface';
import type {
  EmailProviderAdapter,
  EmailProviderCapabilities,
  EmailSendInput,
  EmailSendResult,
  EmailWebhookEvent,
  EmailWebhookEventKind,
  WebhookHeaders,
} from '../../identity/services/email-provider.interface';
import {
  errorFromResponse,
  headerValue,
  providerFetch,
  type ProviderErrorOverrides,
} from './provider-http.util';

export const RESEND_PROVIDER_NAME = 'resend';
const RESEND_SEND_URL = 'https://api.resend.com/emails';
const SVIX_TOLERANCE_SECONDS = 5 * 60;

/** Resend's documented tag charset, for both `name` and `value`. */
const RESEND_TAG_DISALLOWED = /[^A-Za-z0-9_-]/g;
const RESEND_TAG_MAX_LENGTH = 256;
/** Resend's documented `Idempotency-Key` ceiling. */
const RESEND_IDEMPOTENCY_KEY_MAX_LENGTH = 256;

/**
 * Corrections to the shared status rule, from Resend's published error
 * list. Only codes whose status would otherwise be classified WRONGLY are
 * listed — the rest are already right by status alone.
 *
 *   409 `concurrent_idempotent_requests` — an identical idempotent request
 *       is still in flight. The shared rule calls every non-429 4xx
 *       permanent, which would abandon a message that is very likely
 *       about to succeed AND stop the fallback chain. Transient.
 *   429 `daily_quota_exceeded` — free-tier daily cap. Retryable, just not
 *       today; already transient by status, listed so it can never be
 *       re-classified by a future status change on Resend's side.
 *   5xx `application_error` / `internal_server_error` — transient by
 *       status; listed for the same reason.
 *
 * Permanent codes are listed for the mirror-image reason: if Resend ever
 * returned one of them under a 5xx, retrying a malformed request or an
 * unverified sender forever is how a sender gets blocked.
 */
const RESEND_ERROR_OVERRIDES: ProviderErrorOverrides = {
  transientCodes: [
    'concurrent_idempotent_requests',
    'daily_quota_exceeded',
    'rate_limit_exceeded',
    'too_many_requests',
    'application_error',
    'internal_server_error',
  ],
  permanentCodes: [
    'validation_error',
    'missing_required_field',
    'invalid_parameter',
    'invalid_attachment',
    'invalid_from_address',
    'invalid_to_address',
    'invalid_scheduled_at',
    'invalid_idempotency_key',
    'invalid_idempotent_request',
    'invalid_access',
    'invalid_api_key',
    'missing_api_key',
    'restricted_api_key',
    'security_error',
    'not_found',
    'method_not_allowed',
  ],
  // Resend publishes `ratelimit-reset` (seconds until the window resets)
  // alongside `retry-after`; either is a usable delay.
  retryAfterHeaders: ['ratelimit-reset'],
};

const RESEND_EVENT_MAP: Readonly<Record<string, EmailWebhookEventKind>> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.delivery_delayed': 'soft_bounced',
  'email.failed': 'failed',
};

/**
 * Resend mirrors SES's bounce taxonomy. `Permanent` is the only one that
 * may suppress an address forever (`delivered-event.service` turns
 * `bounced` into a permanent suppression): `Transient` is a deferral and
 * `Undetermined` means the remote server did not say — suppressing a
 * possibly-good address on either would lose real mail.
 */
const SOFT_BOUNCE_TYPES: ReadonlySet<string> = new Set(['transient', 'undetermined']);

/** RFC 5322 specials — a display name containing any of them must be quoted. */
const DISPLAY_NAME_SPECIALS = /[()<>[\]:;@\\,."]/;

interface ResendWebhookBody {
  readonly type?: unknown;
  readonly created_at?: unknown;
  readonly data?: {
    readonly email_id?: unknown;
    readonly to?: unknown;
    readonly bounce?: { readonly type?: unknown; readonly message?: unknown };
    readonly failed?: { readonly reason?: unknown };
  };
}

/** `Atlas` → `Atlas`; `Atlas, Inc.` → `"Atlas, Inc."`. Never returns an unquoted special. */
export function formatFromAddress(name: string | undefined, address: string): string {
  const display = (name ?? '').trim();
  if (!display) return address;
  if (!DISPLAY_NAME_SPECIALS.test(display)) return `${display} <${address}>`;
  return `"${display.replace(/([\\"])/g, '\\$1')}" <${address}>`;
}

/**
 * Atlas tag strings → Resend `{ name, value }` pairs inside Resend's
 * charset. `key:course.order.paid` becomes `{ name: 'key', value:
 * 'course_order_paid' }`; a bare `password_reset` becomes `{ name:
 * 'atlas', value: 'password_reset' }`. Names are de-duplicated because a
 * pair list with two identical names carries no information. A tag whose
 * value sanitises to nothing is dropped rather than sent empty.
 */
export function toResendTags(
  tags: readonly string[] | undefined,
): readonly { name: string; value: string }[] | undefined {
  if (!tags || tags.length === 0) return undefined;
  const used = new Set<string>();
  const pairs: { name: string; value: string }[] = [];
  for (const tag of tags) {
    const separator = tag.indexOf(':');
    const rawName = separator > 0 ? tag.slice(0, separator) : 'atlas';
    const rawValue = separator > 0 ? tag.slice(separator + 1) : tag;
    const value = sanitizeTagPart(rawValue);
    if (!value) continue;
    let name = sanitizeTagPart(rawName) || 'atlas';
    if (used.has(name)) {
      let suffix = 2;
      while (used.has(`${name}_${suffix}`)) suffix += 1;
      name = `${name}_${suffix}`;
    }
    used.add(name);
    pairs.push({ name, value });
  }
  return pairs.length > 0 ? pairs : undefined;
}

function sanitizeTagPart(part: string): string {
  return part
    .trim()
    .replace(RESEND_TAG_DISALLOWED, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, RESEND_TAG_MAX_LENGTH);
}

/**
 * Resend caps `Idempotency-Key` at 256 characters. A longer key is
 * replaced by a SHA-256 of itself — deterministic, so the same logical
 * send still collapses to one email, which is the whole point of the
 * header. An empty key is omitted rather than sent blank.
 */
export function normalizeIdempotencyKey(key: string | undefined): string | undefined {
  const trimmed = key?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= RESEND_IDEMPOTENCY_KEY_MAX_LENGTH) return trimmed;
  return createHash('sha256').update(trimmed).digest('hex');
}

@Injectable()
export class ResendEmailProvider implements EmailProviderAdapter {
  readonly name = RESEND_PROVIDER_NAME;

  constructor(private readonly configService: ConfigService) {}

  /** Resend's published free tier: 100 emails/day, 3,000/month, 2 requests/second. */
  capabilities(): EmailProviderCapabilities {
    return {
      dailyLimit: 100,
      monthlyLimit: 3000,
      perSecond: 2,
      supportsWebhooks: true,
      supportsHtml: true,
      supportsIdempotencyKey: true,
    };
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const email = this.configService.getOrThrow<EmailConfig>('email');
    const apiKey = email.resendApiKey ?? email.apiKey;
    if (!apiKey || !email.fromEmail) {
      throw new EmailProviderError(
        this.name,
        'permanent',
        'ResendEmailProvider is active but RESEND_API_KEY/EMAIL_FROM_EMAIL are not configured.',
      );
    }
    const replyTo = input.replyTo ?? email.replyTo;
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const tags = toResendTags(input.tags);
    const response = await providerFetch(this.name, RESEND_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: formatFromAddress(email.fromName, email.fromEmail),
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        ...(tags ? { tags } : {}),
      }),
    });

    if (!response.ok)
      throw await errorFromResponse(this.name, response, RESEND_ERROR_OVERRIDES);

    let providerMessageId: string | null = null;
    try {
      const body = (await response.json()) as { id?: unknown } | null;
      providerMessageId = typeof body?.id === 'string' && body.id ? body.id : null;
    } catch {
      // A 2xx Resend accepted but whose body we cannot read is still an
      // accepted send — losing the id only costs us webhook correlation,
      // and re-sending would double-deliver.
      providerMessageId = null;
    }
    return { providerMessageId, provider: this.name };
  }

  verifyWebhook(headers: WebhookHeaders, rawBody: string): boolean {
    const secret = this.webhookSecret();
    // FAIL CLOSED: no secret configured means no request can be trusted,
    // so the endpoint accepts nothing at all.
    if (!secret) return false;

    const id = headerValue(headers, 'svix-id') ?? headerValue(headers, 'webhook-id');
    const timestamp =
      headerValue(headers, 'svix-timestamp') ?? headerValue(headers, 'webhook-timestamp');
    const signatureHeader =
      headerValue(headers, 'svix-signature') ?? headerValue(headers, 'webhook-signature');
    if (!id || !timestamp || !signatureHeader) return false;

    // Strictly an integer: `Number(' 12 ')` and `Number('1e9')` both parse,
    // and neither is a Svix timestamp.
    if (!/^\d{1,15}$/.test(timestamp.trim())) return false;
    const ts = Number(timestamp.trim());
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - ts) > SVIX_TOLERANCE_SECONDS) return false;

    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    if (key.length === 0) return false;
    const expected = createHmac('sha256', key)
      .update(`${id}.${timestamp}.${rawBody}`)
      .digest();

    // Every `v1,` entry is compared and the results OR-ed: Svix rotates by
    // sending the old and the new signature together.
    let matched = false;
    for (const entry of signatureHeader.split(/\s+/)) {
      const trimmed = entry.trim();
      if (!trimmed.startsWith('v1,')) continue;
      const provided = Buffer.from(trimmed.slice(3), 'base64');
      // `timingSafeEqual` throws on a length mismatch, so the lengths are
      // checked first; the comparison itself stays constant-time.
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        matched = true;
      }
    }
    return matched;
  }

  parseWebhookEvents(body: unknown): EmailWebhookEvent[] {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
    const payload = body as ResendWebhookBody;
    const kind =
      typeof payload.type === 'string' ? RESEND_EVENT_MAP[payload.type] : undefined;
    const data = payload.data;
    const messageId = typeof data?.email_id === 'string' ? data.email_id : undefined;
    if (!kind || !messageId) return [];

    const recipients: string[] = Array.isArray(data?.to)
      ? data.to.filter((entry): entry is string => typeof entry === 'string' && !!entry)
      : typeof data?.to === 'string' && data.to
        ? [data.to]
        : [];
    if (recipients.length === 0) return [];

    const created =
      typeof payload.created_at === 'string'
        ? Date.parse(payload.created_at)
        : Number.NaN;
    const occurredAt = Number.isNaN(created) ? new Date() : new Date(created);

    // Resend reports deferrals under the same `email.bounced` event with a
    // `bounce.type`; only a `Permanent` one may suppress the address.
    const bounceType =
      typeof data?.bounce?.type === 'string' ? data.bounce.type.toLowerCase() : undefined;
    const event: EmailWebhookEventKind =
      kind === 'bounced' && bounceType && SOFT_BOUNCE_TYPES.has(bounceType)
        ? 'soft_bounced'
        : kind;
    const reason =
      typeof data?.bounce?.message === 'string'
        ? data.bounce.message
        : typeof data?.failed?.reason === 'string'
          ? data.failed.reason
          : undefined;

    return recipients.map((recipientEmail) => ({
      providerMessageId: messageId,
      recipientEmail,
      event,
      occurredAt,
      reason,
    }));
  }

  /** Reading config must never turn a forged webhook into a 500; an unreadable config is simply "no secret". */
  private webhookSecret(): string | undefined {
    try {
      return this.configService.getOrThrow<EmailConfig>('email').resendWebhookSecret;
    } catch {
      return undefined;
    }
  }
}
