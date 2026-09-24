/**
 * BrevoEmailProvider — PRIMARY transactional-email adapter (owner
 * decision, P64 Communications). Brevo Free: 300/day, single-sender
 * verification against the owner's Gmail address (no domain DNS), footer
 * accepted. `POST https://api.brevo.com/v3/smtp/email`, `api-key` header,
 * Node 20 `fetch` only.
 *
 * Inbound: Brevo transactional webhooks carry NO signature. Authentication
 * is a shared secret in the webhook URL (`?secret=` →
 * `BREVO_WEBHOOK_SECRET`), compared constant-time. The controller folds
 * that query value into the headers map under `WEBHOOK_URL_SECRET_HEADER`.
 *
 * Never logs addresses, API keys or message content.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { EmailConfig } from '../../config/configuration';
import {
  EmailProviderError,
  WEBHOOK_URL_SECRET_HEADER,
} from '../../identity/services/email-provider.interface';
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

export const BREVO_PROVIDER_NAME = 'brevo';
const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';

/** Brevo transactional event names → Atlas's provider-neutral vocabulary. `request`/`deferred`/`unsubscribed` carry no delivery state and are dropped. */
const BREVO_EVENT_MAP: Readonly<Record<string, EmailWebhookEventKind>> = {
  delivered: 'delivered',
  hard_bounce: 'bounced',
  soft_bounce: 'soft_bounced',
  spam: 'complained',
  complaint: 'complained',
  opened: 'opened',
  unique_opened: 'opened',
  click: 'clicked',
  blocked: 'failed',
  invalid_email: 'failed',
  error: 'failed',
};

interface BrevoWebhookBody {
  readonly event?: unknown;
  readonly email?: unknown;
  readonly 'message-id'?: unknown;
  readonly messageId?: unknown;
  readonly date?: unknown;
  readonly ts_event?: unknown;
  readonly ts?: unknown;
  readonly reason?: unknown;
}

function constantTimeEquals(a: string, b: string): boolean {
  // Hash both sides so length never leaks and `timingSafeEqual` never throws.
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

@Injectable()
export class BrevoEmailProvider implements EmailProviderAdapter {
  readonly name = BREVO_PROVIDER_NAME;

  constructor(private readonly configService: ConfigService) {}

  capabilities(): EmailProviderCapabilities {
    return {
      dailyLimit: 300,
      monthlyLimit: 9000,
      perSecond: 5,
      supportsWebhooks: true,
      supportsHtml: true,
      supportsIdempotencyKey: false,
    };
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const email = this.configService.getOrThrow<EmailConfig>('email');
    if (!email.brevoApiKey || !email.fromEmail) {
      throw new EmailProviderError(
        this.name,
        'permanent',
        'BrevoEmailProvider is active but BREVO_API_KEY/EMAIL_FROM_EMAIL are not configured.',
      );
    }
    const replyTo = input.replyTo ?? email.replyTo;
    const response = await providerFetch(this.name, BREVO_SEND_URL, {
      method: 'POST',
      headers: {
        'api-key': email.brevoApiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: email.fromName, email: email.fromEmail },
        to: [{ email: input.to }],
        subject: input.subject,
        textContent: input.text,
        ...(input.html ? { htmlContent: input.html } : {}),
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
        ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {}),
      }),
    });

    if (!response.ok) throw await errorFromResponse(this.name, response);

    let providerMessageId: string | null = null;
    try {
      const body = (await response.json()) as { messageId?: unknown };
      providerMessageId = typeof body.messageId === 'string' ? body.messageId : null;
    } catch {
      providerMessageId = null;
    }
    return { providerMessageId, provider: this.name };
  }

  verifyWebhook(headers: WebhookHeaders, _rawBody: string): boolean {
    const secret = this.configService.getOrThrow<EmailConfig>('email').brevoWebhookSecret;
    if (!secret) return false;
    const provided = headerValue(headers, WEBHOOK_URL_SECRET_HEADER);
    if (!provided) return false;
    return constantTimeEquals(provided, secret);
  }

  /** Brevo posts one JSON object per event; some configurations batch an array. Both are accepted. */
  parseWebhookEvents(body: unknown): EmailWebhookEvent[] {
    const items: unknown[] = Array.isArray(body) ? body : [body];
    const events: EmailWebhookEvent[] = [];
    for (const item of items) {
      const parsed = this.parseOne(item);
      if (parsed) events.push(parsed);
    }
    return events;
  }

  private parseOne(item: unknown): EmailWebhookEvent | null {
    if (!item || typeof item !== 'object') return null;
    const body = item as BrevoWebhookBody;
    const kind = typeof body.event === 'string' ? BREVO_EVENT_MAP[body.event] : undefined;
    const messageId =
      typeof body['message-id'] === 'string'
        ? body['message-id']
        : typeof body.messageId === 'string'
          ? body.messageId
          : undefined;
    const recipient = typeof body.email === 'string' ? body.email : undefined;
    if (!kind || !messageId || !recipient) return null;

    let occurredAt = new Date();
    if (typeof body.ts_event === 'number') occurredAt = new Date(body.ts_event * 1000);
    else if (typeof body.ts === 'number') occurredAt = new Date(body.ts * 1000);
    else if (typeof body.date === 'string') {
      // Brevo's `date` is "YYYY-MM-DD HH:mm:ss" (no zone) — treat as UTC.
      const iso = body.date.includes('T') ? body.date : `${body.date.replace(' ', 'T')}Z`;
      const parsed = Date.parse(iso);
      if (!Number.isNaN(parsed)) occurredAt = new Date(parsed);
    }

    return {
      providerMessageId: messageId,
      recipientEmail: recipient,
      event: kind,
      occurredAt,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
    };
  }
}
