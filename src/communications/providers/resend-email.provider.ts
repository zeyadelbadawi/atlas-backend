/**
 * ResendEmailProvider — FALLBACK transactional-email adapter (owner
 * decision, P64 Communications; P17 originally shipped it as the only
 * real provider). `POST https://api.resend.com/emails`, Bearer key, Node
 * 20 `fetch` only; sends `Idempotency-Key` when the caller supplies one.
 *
 * Inbound: Resend webhooks are signed by Svix — `svix-id`,
 * `svix-timestamp`, `svix-signature` (`v1,<base64>` entries, space
 * separated); the signed content is `${id}.${timestamp}.${rawBody}` under
 * HMAC-SHA256 with the secret after the `whsec_` prefix (base64-decoded).
 * A five-minute timestamp tolerance rejects replays.
 *
 * Never logs addresses, API keys or message content.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
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
import { errorFromResponse, headerValue, providerFetch } from './provider-http.util';

export const RESEND_PROVIDER_NAME = 'resend';
const RESEND_SEND_URL = 'https://api.resend.com/emails';
const SVIX_TOLERANCE_SECONDS = 5 * 60;

const RESEND_EVENT_MAP: Readonly<Record<string, EmailWebhookEventKind>> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.delivery_delayed': 'soft_bounced',
  'email.failed': 'failed',
};

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

@Injectable()
export class ResendEmailProvider implements EmailProviderAdapter {
  readonly name = RESEND_PROVIDER_NAME;

  constructor(private readonly configService: ConfigService) {}

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
    const response = await providerFetch(this.name, RESEND_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: `${email.fromName} <${email.fromEmail}>`,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.tags && input.tags.length > 0
          ? { tags: input.tags.map((tag) => ({ name: 'atlas', value: tag })) }
          : {}),
      }),
    });

    if (!response.ok) throw await errorFromResponse(this.name, response);

    let providerMessageId: string | null = null;
    try {
      const body = (await response.json()) as { id?: unknown };
      providerMessageId = typeof body.id === 'string' ? body.id : null;
    } catch {
      providerMessageId = null;
    }
    return { providerMessageId, provider: this.name };
  }

  verifyWebhook(headers: WebhookHeaders, rawBody: string): boolean {
    const secret =
      this.configService.getOrThrow<EmailConfig>('email').resendWebhookSecret;
    if (!secret) return false;
    const id = headerValue(headers, 'svix-id');
    const timestamp = headerValue(headers, 'svix-timestamp');
    const signatureHeader = headerValue(headers, 'svix-signature');
    if (!id || !timestamp || !signatureHeader) return false;

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - ts) > SVIX_TOLERANCE_SECONDS) return false;

    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', key)
      .update(`${id}.${timestamp}.${rawBody}`)
      .digest();

    return signatureHeader
      .split(' ')
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith('v1,'))
      .some((entry) => {
        const provided = Buffer.from(entry.slice(3), 'base64');
        return provided.length === expected.length && timingSafeEqual(provided, expected);
      });
  }

  parseWebhookEvents(body: unknown): EmailWebhookEvent[] {
    if (!body || typeof body !== 'object') return [];
    const payload = body as ResendWebhookBody;
    const kind =
      typeof payload.type === 'string' ? RESEND_EVENT_MAP[payload.type] : undefined;
    const data = payload.data;
    const messageId = typeof data?.email_id === 'string' ? data.email_id : undefined;
    if (!kind || !messageId) return [];

    const recipients: string[] = Array.isArray(data?.to)
      ? data.to.filter((entry): entry is string => typeof entry === 'string')
      : typeof data?.to === 'string'
        ? [data.to]
        : [];
    if (recipients.length === 0) return [];

    const created =
      typeof payload.created_at === 'string'
        ? Date.parse(payload.created_at)
        : Number.NaN;
    const occurredAt = Number.isNaN(created) ? new Date() : new Date(created);

    // Resend reports transient bounces under the same event with `bounce.type`.
    const bounceType =
      typeof data?.bounce?.type === 'string' ? data.bounce.type : undefined;
    const event: EmailWebhookEventKind =
      kind === 'bounced' && bounceType?.toLowerCase() === 'transient'
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
}
