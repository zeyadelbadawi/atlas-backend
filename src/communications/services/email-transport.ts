/**
 * EmailTransport — the one seam between the dispatcher and whatever is
 * bound to `EMAIL_PROVIDER`.
 *
 * It exists to keep ONE translation in one place. The dispatcher speaks
 * in the terms an email event has (`{ key, category }` — a labelled pair
 * it can build without knowing any vendor); `EmailSendInput` speaks in
 * the terms the vendors share (a FLAT list of tag strings, plus the
 * quota `category` the registry reserves against). Brevo takes tags as
 * plain strings and Resend as `{ name, value }` pairs, so a record would
 * have to be flattened somewhere regardless; doing it here means the
 * dispatcher never learns a vendor's shape and every provider receives
 * the same `key:value` convention.
 *
 * `category` is forwarded rather than flattened into a tag: the registry
 * reserves quota per category, so losing it would bill every outbox email
 * to the default line.
 */
import { Inject, Injectable } from '@nestjs/common';
import { EMAIL_PROVIDER } from '../../identity/services/email-provider.interface';
import type {
  EmailCategory,
  EmailProvider,
} from '../../identity/services/email-provider.interface';

export interface EmailTransportInput {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly replyTo?: string;
  readonly headers?: Record<string, string>;
  readonly idempotencyKey?: string;
  /** Labelled tags; flattened to `key:value` strings for the provider. */
  readonly tags?: Record<string, string>;
  /** Quota line to reserve against; defaults to `transactional`. */
  readonly category?: EmailCategory;
}

export interface EmailTransportResult {
  readonly providerMessageId: string | null;
  readonly provider: string;
}

/**
 * `{ key: 'course.enrolled', category: 'transactional' }` →
 * `['key:course.enrolled', 'category:transactional']`. Flat strings are
 * the only shape both vendors accept (see this file's header).
 */
function flattenTags(tags: Record<string, string> | undefined): string[] | undefined {
  if (!tags) return undefined;
  const flattened = Object.entries(tags).map(([name, value]) => `${name}:${value}`);
  return flattened.length > 0 ? flattened : undefined;
}

@Injectable()
export class EmailTransport {
  constructor(@Inject(EMAIL_PROVIDER) private readonly provider: EmailProvider) {}

  get providerName(): string {
    const name = (this.provider as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
    return this.provider.constructor?.name ?? 'unknown';
  }

  async send(input: EmailTransportInput): Promise<EmailTransportResult> {
    const result = await this.provider.send({
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: input.replyTo,
      headers: input.headers,
      idempotencyKey: input.idempotencyKey,
      tags: flattenTags(input.tags),
      category: input.category,
    });
    return {
      providerMessageId: result.providerMessageId ?? null,
      provider: result.provider ?? this.providerName,
    };
  }
}
