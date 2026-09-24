/**
 * EmailProviderRegistry — what the `EMAIL_PROVIDER` token resolves to.
 *
 * Holds the adapters in `EMAIL_PROVIDERS` order (default `stub`; approved
 * production shape `brevo,resend`) and, per `send()`:
 *
 *   1. skip a provider whose class-line budget is exhausted
 *      (`EmailQuotaService.reserve`);
 *   2. on a TRANSIENT error (429/5xx/network) move to the next provider;
 *   3. on a PERMANENT error (4xx) stop — the request itself is wrong and no
 *      other provider will take it;
 *   4. with nobody left, throw the last error (or a transient
 *      "exhausted" one so the caller's retry policy applies).
 *
 * The three legacy methods (`sendPasswordResetEmail`, `sendEmailVerification`,
 * `sendTransactionalEmail`) are delegations to `send()` — one real send
 * path. Never logs addresses; the outcome, provider and category only.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  EmailProviderError,
  type EmailProvider,
  type EmailProviderAdapter,
  type EmailProviderCapabilities,
  type EmailSendInput,
  type EmailSendResult,
  type EmailWebhookEvent,
  type TransactionalEmailInput,
  type WebhookHeaders,
} from '../../identity/services/email-provider.interface';
import { EmailQuotaService } from '../services/email-quota.service';
import { CommunicationMetricsService } from '../services/communication-metrics.service';
import { buildEmailVerificationEmail, buildPasswordResetEmail } from './legacy-messages';

@Injectable()
export class EmailProviderRegistry implements EmailProvider {
  readonly name = 'registry';
  private readonly logger = new Logger(EmailProviderRegistry.name);

  constructor(
    private readonly providers: readonly EmailProviderAdapter[],
    private readonly quota: EmailQuotaService,
    private readonly metrics: CommunicationMetricsService,
  ) {
    if (providers.length === 0) {
      throw new Error(
        'EmailProviderRegistry needs at least one provider (EMAIL_PROVIDERS).',
      );
    }
  }

  /** Adapter names in fallback order — for logs and the webhook controller. */
  providerNames(): readonly string[] {
    return this.providers.map((provider) => provider.name);
  }

  /** The adapter behind a name, whether or not it is in the send chain is irrelevant here: only chain members are registered. */
  find(name: string): EmailProviderAdapter | undefined {
    return this.providers.find((provider) => provider.name === name);
  }

  /** The union of the chain: unlimited on any axis where any member is unlimited. */
  capabilities(): EmailProviderCapabilities {
    const sum = (pick: (c: EmailProviderCapabilities) => number | undefined) => {
      let total = 0;
      for (const provider of this.providers) {
        const value = pick(provider.capabilities());
        if (value === undefined) return undefined;
        total += value;
      }
      return total;
    };
    return {
      dailyLimit: sum((c) => c.dailyLimit),
      monthlyLimit: sum((c) => c.monthlyLimit),
      perSecond: sum((c) => c.perSecond),
      supportsWebhooks: this.providers.some((p) => p.capabilities().supportsWebhooks),
      supportsHtml: this.providers.every((p) => p.capabilities().supportsHtml),
      supportsIdempotencyKey: this.providers.every(
        (p) => p.capabilities().supportsIdempotencyKey,
      ),
    };
  }

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const category = input.category ?? 'transactional';
    let lastError: EmailProviderError | undefined;

    for (const provider of this.providers) {
      const capabilities = provider.capabilities();
      const decision = await this.quota.reserve(provider.name, category, capabilities);
      if (!decision.ok) {
        this.metrics.recordSend(provider.name, category, 'quota_skipped');
        this.logger.warn(
          { provider: provider.name, category, reason: decision.reason },
          'Email provider skipped: quota line exhausted.',
        );
        continue;
      }

      try {
        const result = await provider.send(input);
        await this.quota.recordAccepted(provider.name, capabilities);
        this.metrics.recordSend(provider.name, category, 'sent');
        return { providerMessageId: result.providerMessageId, provider: provider.name };
      } catch (error) {
        const providerError =
          error instanceof EmailProviderError
            ? error
            : new EmailProviderError(
                provider.name,
                'transient',
                error instanceof Error ? error.message : String(error),
              );
        lastError = providerError;
        this.metrics.recordSend(
          provider.name,
          category,
          providerError.kind === 'permanent' ? 'permanent_error' : 'transient_error',
        );
        this.logger.warn(
          {
            provider: provider.name,
            category,
            kind: providerError.kind,
            status: providerError.status,
            retryAfterMs: providerError.retryAfterMs,
          },
          providerError.kind === 'permanent'
            ? 'Email provider rejected the message permanently — not trying another provider.'
            : 'Email provider failed transiently — trying the next provider.',
        );
        if (providerError.kind === 'permanent') throw providerError;
      }
    }

    throw (
      lastError ??
      new EmailProviderError(
        this.name,
        'transient',
        'No email provider had quota available for this category.',
      )
    );
  }

  /** Delegates to the adapter named by the route; the controller picks the adapter, so the registry itself never verifies. */
  verifyWebhook(_headers: WebhookHeaders, _rawBody: string): boolean {
    return false;
  }

  parseWebhookEvents(_body: unknown): EmailWebhookEvent[] {
    return [];
  }

  // --- Legacy surface (P1 / 10.1 / P17) — delegations to `send()` -----------

  async sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
    await this.send(buildPasswordResetEmail(to, rawToken));
  }

  async sendEmailVerification(to: string, rawToken: string): Promise<void> {
    await this.send(buildEmailVerificationEmail(to, rawToken));
  }

  async sendTransactionalEmail(input: TransactionalEmailInput): Promise<void> {
    await this.send({
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      category: 'transactional',
    });
  }
}
