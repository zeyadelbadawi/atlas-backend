/**
 * `EmailProvider` — the transactional-email boundary.
 *
 * P1 shipped `sendPasswordResetEmail`, Phase 10.1 `sendEmailVerification`
 * and P17 `sendTransactionalEmail`; those three are the LEGACY surface and
 * are kept exactly as-is so `AuthService`, `PasswordResetEmailProcessor`
 * and `EmailService` keep working unchanged. P64 Communications (provider
 * layer) widened the contract with the adapter-shaped members below:
 *
 *   - `name` / `capabilities()`  — what the registry needs to budget and
 *     route (`EmailQuotaService`).
 *   - `send()`                   — the one real send path; returns the
 *     provider's message id so `communication_deliveries` can be matched
 *     against inbound delivery webhooks.
 *   - `verifyWebhook()` / `parseWebhookEvents()` — the inbound half, so
 *     provider-specific event vocabularies never leak past the adapter.
 *
 * Concrete adapters (`BrevoEmailProvider`, `ResendEmailProvider`,
 * `StubEmailProvider`) implement `EmailProviderAdapter`. The DI token
 * `EMAIL_PROVIDER` resolves to `EmailProviderRegistry`, which implements
 * the full `EmailProvider` (adapter surface + legacy methods, the legacy
 * ones delegating to `send`) and does the ordering, quota-skipping and
 * fallback. Nothing outside `src/communications/providers` knows which
 * vendor is active.
 */

/** P17's original input — unchanged. */
export interface TransactionalEmailInput {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/** Mirrors `CommunicationCategory` in the Prisma schema; the quota lines key on it. */
export type EmailCategory =
  'security' | 'transactional' | 'lifecycle' | 'engagement' | 'operational';

export interface EmailProviderCapabilities {
  /** Undefined = unlimited (the stub). */
  readonly dailyLimit?: number;
  readonly monthlyLimit?: number;
  readonly perSecond?: number;
  readonly supportsWebhooks: boolean;
  readonly supportsHtml: boolean;
  readonly supportsIdempotencyKey: boolean;
}

export interface EmailSendInput {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly replyTo?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
  readonly tags?: readonly string[];
  /** Which quota line the registry reserves against. Defaults to `transactional`. */
  readonly category?: EmailCategory;
}

export interface EmailSendResult {
  /** Null when the provider accepted the message without returning an id (the stub, or a provider response without one). */
  readonly providerMessageId: string | null;
  /** Which adapter actually accepted the message — set by the registry. */
  readonly provider?: string;
}

export type EmailWebhookEventKind =
  | 'delivered'
  | 'bounced'
  | 'soft_bounced'
  | 'complained'
  | 'opened'
  | 'clicked'
  | 'failed';

export interface EmailWebhookEvent {
  readonly providerMessageId: string;
  readonly recipientEmail: string;
  readonly event: EmailWebhookEventKind;
  readonly occurredAt: Date;
  readonly reason?: string;
}

/**
 * Inbound request headers, lower-cased. The controller also folds the
 * URL secret (`?secret=`) in under `WEBHOOK_URL_SECRET_HEADER` so adapters
 * that authenticate by shared URL secret (Brevo has no HMAC) and adapters
 * that authenticate by signature header (Resend/Svix) share one signature.
 */
export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;
export const WEBHOOK_URL_SECRET_HEADER = 'x-atlas-webhook-url-secret';

/** What a concrete vendor adapter implements. */
export interface EmailProviderAdapter {
  readonly name: string;
  capabilities(): EmailProviderCapabilities;
  send(input: EmailSendInput): Promise<EmailSendResult>;
  verifyWebhook(headers: WebhookHeaders, rawBody: string): boolean;
  parseWebhookEvents(body: unknown): EmailWebhookEvent[];
}

/**
 * The full contract behind `EMAIL_PROVIDER` — the adapter surface plus
 * the one remaining legacy convenience.
 *
 * `sendPasswordResetEmail` and `sendEmailVerification` were removed: they
 * composed their own message and pasted the raw token into the body, so
 * the recipient was handed an internal credential with no action. Both
 * flows emit `auth.password.reset` / `auth.email.verification` now, which
 * render the bilingual template with a CTA and keep the token in the href.
 */
export interface EmailProvider extends EmailProviderAdapter {
  sendTransactionalEmail(input: TransactionalEmailInput): Promise<void>;
}

/**
 * Thrown by adapters (and re-thrown by the registry once every provider is
 * exhausted). `transient` = worth trying the next provider / retrying
 * later (429, 5xx, network); `permanent` = the request itself is wrong
 * (4xx other than 429) — no other provider will accept it either.
 */
export class EmailProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: 'transient' | 'permanent',
    message: string,
    readonly status?: number,
    /** Honoured `Retry-After`, in milliseconds, when the provider sent one. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'EmailProviderError';
  }
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
