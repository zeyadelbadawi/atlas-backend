/**
 * StubEmailProvider — the no-network adapter (default in every dev/test
 * environment; `EMAIL_PROVIDERS=stub`).
 *
 * Never logs a raw token or any URL built from it — only that a send was
 * attempted, for a masked address. Testability without logging a secret:
 * it keeps the most recent send per normalised address in memory for the
 * lifetime of the process, and the P1/10.1 `peek*` helpers read the token
 * back out of that recorded message (see `legacy-messages.ts`). Nothing
 * HTTP-reachable exposes any of it — e2e tests read it straight off the
 * Nest testing module.
 *
 * Capabilities are unlimited (no `dailyLimit`/`monthlyLimit`/`perSecond`)
 * so the registry never budgets it; `supportsWebhooks` is false so the
 * webhook controller refuses `/webhooks/email/stub` outright.
 */
import { Injectable, Logger } from '@nestjs/common';
import type {
  EmailProviderAdapter,
  EmailProviderCapabilities,
  EmailSendInput,
  EmailSendResult,
  EmailWebhookEvent,
  TransactionalEmailInput,
  WebhookHeaders,
} from '../../identity/services/email-provider.interface';
import { normalizeEmail } from '../../identity/utils/email.util';
import { maskEmail } from './provider-http.util';
import {
  EMAIL_VERIFICATION_EVENT_TAG,
  EMAIL_VERIFICATION_TAG,
  PASSWORD_RESET_EVENT_TAG,
  PASSWORD_RESET_TAG,
  extractEmailVerificationToken,
  extractPasswordResetToken,
} from './legacy-messages';

export const STUB_PROVIDER_NAME = 'stub';

@Injectable()
export class StubEmailProvider implements EmailProviderAdapter {
  readonly name = STUB_PROVIDER_NAME;
  private readonly logger = new Logger(StubEmailProvider.name);

  private readonly lastPasswordResetTokens = new Map<string, string>();
  private readonly lastEmailVerificationTokens = new Map<string, string>();
  private readonly lastTransactionalEmails = new Map<string, TransactionalEmailInput>();
  private readonly sends: EmailSendInput[] = [];
  private sequence = 0;

  capabilities(): EmailProviderCapabilities {
    return { supportsWebhooks: false, supportsHtml: true, supportsIdempotencyKey: true };
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const normalized = normalizeEmail(input.to);
    this.sends.push(input);
    const tags = input.tags ?? [];
    // Both credential emails now arrive through the outbox, so the tag
    // that identifies them is the CATALOGUE KEY the transport flattens
    // (`key:auth.password.reset`), not the legacy `password_reset`
    // marker. The old tags are still matched so an older deployment's
    // in-flight job classifies the same way.
    if (tags.includes(PASSWORD_RESET_EVENT_TAG) || tags.includes(PASSWORD_RESET_TAG)) {
      // The link is in both parts; prefer the HTML, which is where the
      // CTA href actually is.
      const token =
        extractPasswordResetToken(input.html ?? '') ??
        extractPasswordResetToken(input.text);
      if (token) this.lastPasswordResetTokens.set(normalized, token);
      this.logger.log(
        { to: maskEmail(normalized) },
        'Stub email provider: password reset email would be sent (no real provider configured)',
      );
    } else if (
      tags.includes(EMAIL_VERIFICATION_EVENT_TAG) ||
      tags.includes(EMAIL_VERIFICATION_TAG)
    ) {
      const token =
        extractEmailVerificationToken(input.html ?? '') ??
        extractEmailVerificationToken(input.text);
      if (token) this.lastEmailVerificationTokens.set(normalized, token);
      this.logger.log(
        { to: maskEmail(normalized) },
        'Stub email provider: verification email would be sent (no real provider configured)',
      );
    } else {
      this.lastTransactionalEmails.set(normalized, {
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
      });
      this.logger.log(
        { to: maskEmail(normalized), subject: input.subject, category: input.category },
        'Stub email provider: transactional email would be sent (no real provider configured — set EMAIL_PROVIDERS)',
      );
    }
    this.sequence += 1;
    return {
      providerMessageId: `stub-${process.pid}-${this.sequence}`,
      provider: this.name,
    };
  }

  verifyWebhook(_headers: WebhookHeaders, _rawBody: string): boolean {
    return false;
  }

  parseWebhookEvents(_body: unknown): EmailWebhookEvent[] {
    return [];
  }

  // --- Test-only accessors — never called from any controller/HTTP path. ---

  peekLastPasswordResetToken(email: string): string | undefined {
    return this.lastPasswordResetTokens.get(normalizeEmail(email));
  }

  peekLastEmailVerificationToken(email: string): string | undefined {
    return this.lastEmailVerificationTokens.get(normalizeEmail(email));
  }

  peekLastTransactionalEmail(email: string): TransactionalEmailInput | undefined {
    return this.lastTransactionalEmails.get(normalizeEmail(email));
  }

  /** Every `send()` input this process has recorded, oldest first. */
  recordedSends(): readonly EmailSendInput[] {
    return this.sends;
  }
}
