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
  EmailQuotaExhaustedError,
  type EmailProvider,
  type EmailProviderAdapter,
  type EmailProviderCapabilities,
  type EmailSendInput,
  type EmailSendResult,
  type EmailWebhookEvent,
  type TransactionalEmailInput,
  type WebhookHeaders,
} from '../../identity/services/email-provider.interface';
import { EmailQuotaService, type QuotaDecision } from '../services/email-quota.service';
import { CommunicationMetricsService } from '../services/communication-metrics.service';
import { STUB_PROVIDER_NAME } from './stub-email.provider';

/**
 * `EMAIL_PROVIDERS` (already lower-cased and validated by the env schema)
 * → the adapters, in order. Names with no adapter are dropped and a
 * repeated name is taken once: the chain is also what `capabilities()`
 * sums, so a duplicate would advertise twice the daily budget that
 * actually exists and would try the same failing vendor twice.
 *
 * The chain is EXACTLY what the configuration names — nothing is appended
 * as a safety net. That is deliberate: silently falling back to the stub
 * would turn "no provider could send this" into a silent success, with a
 * password-reset email that nobody ever receives and a `sent` row that
 * says otherwise. `stub` reaches the chain only when an operator puts it
 * in `EMAIL_PROVIDERS`.
 */
export function buildProviderChain(
  order: readonly string[],
  byName: Readonly<Record<string, EmailProviderAdapter>>,
): readonly EmailProviderAdapter[] {
  const seen = new Set<string>();
  const chain: EmailProviderAdapter[] = [];
  for (const name of order) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    const adapter = byName[key];
    if (!adapter) continue;
    seen.add(key);
    chain.push(adapter);
  }
  return chain;
}

/**
 * W3-compose — when an exhausted quota window resets: the next UTC day for
 * a daily line, the first of next month (UTC) for a monthly line, the next
 * second for the per-second limiter. Matches `EmailQuotaService`'s key
 * windows (`d:{yyyymmdd}`, `m:{yyyymm}`, `rate:{epochSecond}`), which are UTC.
 */
export function quotaResetAt(reason: 'daily' | 'monthly' | 'rate', now: Date): Date {
  if (reason === 'rate') return new Date(Math.floor(now.getTime() / 1000) * 1000 + 1000);
  if (reason === 'daily') {
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

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

    // A production chain made only of stubs accepts every message and
    // delivers none: password resets and OTP codes are "sent" and never
    // arrive. It is NOT fatal on purpose — refusing to boot would take
    // the whole platform down over an email misconfiguration, and a
    // learner who cannot reach their course is a worse outcome than one
    // who cannot reset a password. So it is made impossible to miss
    // instead: an error-level line at boot, and the same state rendered
    // as a warning on the platform communications console.
    if (
      process.env.NODE_ENV === 'production' &&
      providers.every((provider) => provider.name === STUB_PROVIDER_NAME)
    ) {
      this.logger.error(
        { chain: providers.map((provider) => provider.name) },
        'EMAIL IS NOT BEING DELIVERED: the production provider chain contains only the stub. ' +
          'Every email will be accepted and silently discarded. Set EMAIL_PROVIDERS to a real ' +
          'provider with its credentials.',
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
    // W3-compose — the reset instant of every quota line that refused, so
    // "nobody had quota" can say WHEN somebody will.
    const quotaRefusals: Extract<QuotaDecision, { ok: false }>['reason'][] = [];

    for (const provider of this.providers) {
      const capabilities = provider.capabilities();
      const decision = await this.quota.reserve(provider.name, category, capabilities);
      if (!decision.ok) {
        quotaRefusals.push(decision.reason);
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

    if (lastError) throw lastError;
    // Every provider was skipped for quota and none was even tried: a
    // distinct, still-transient error carrying the earliest reset, so the
    // dispatcher can defer the row instead of burning its retries.
    const now = new Date();
    const resets = quotaRefusals.map((reason) => ({
      reason,
      at: quotaResetAt(reason, now),
    }));
    const earliest = resets.sort((a, b) => a.at.getTime() - b.at.getTime())[0];
    throw new EmailQuotaExhaustedError(
      earliest?.at ?? quotaResetAt('daily', now),
      earliest?.reason ?? 'daily',
    );
  }

  /** Delegates to the adapter named by the route; the controller picks the adapter, so the registry itself never verifies. */
  verifyWebhook(_headers: WebhookHeaders, _rawBody: string): boolean {
    return false;
  }

  parseWebhookEvents(_body: unknown): EmailWebhookEvent[] {
    return [];
  }

  /*
    The two credential-email methods that used to live here are gone.
    They composed the message themselves — pasting the raw reset or
    verification token into the body as a line of text — which is how a
    user ended up holding an internal credential with no action attached.
    Both flows now emit their catalogue event, so the one bilingual
    template renders a CTA and the token stays inside the href.

    Deleting them rather than leaving them unused is the point: a second
    way to compose an email is a second way to get it wrong, and the next
    person would have reached for the shorter one.
  */

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
