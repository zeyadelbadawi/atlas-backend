/**
 * EmailTransport — the one seam between this module and whatever is bound
 * to `EMAIL_PROVIDER`. Duck-typed on purpose: the provider registry that
 * ships alongside this work exposes `send(input) → { providerMessageId,
 * provider }`; today's stub and Resend providers expose only the legacy
 * `sendTransactionalEmail(input) → void`. Preferring `send` when present
 * and falling back otherwise keeps this branch working against either
 * without a DI change.
 */
import { Inject, Injectable } from '@nestjs/common';
import { EMAIL_PROVIDER } from '../../identity/services/email-provider.interface';
import type { EmailProvider } from '../../identity/services/email-provider.interface';

export interface EmailTransportInput {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly replyTo?: string;
  readonly headers?: Record<string, string>;
  readonly idempotencyKey?: string;
  readonly tags?: Record<string, string>;
}

export interface EmailTransportResult {
  readonly providerMessageId: string | null;
  readonly provider: string;
}

interface RichEmailProvider {
  readonly name?: string;
  send(
    input: EmailTransportInput,
  ): Promise<{ providerMessageId: string | null; provider?: string }>;
}

function hasSend(provider: unknown): provider is RichEmailProvider {
  return typeof (provider as { send?: unknown }).send === 'function';
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
    if (hasSend(this.provider)) {
      const result = await this.provider.send(input);
      return {
        providerMessageId: result.providerMessageId ?? null,
        provider: result.provider ?? this.providerName,
      };
    }
    await this.provider.sendTransactionalEmail({
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return { providerMessageId: null, provider: this.providerName };
  }
}
