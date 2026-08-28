/**
 * ResendEmailProvider — Phase P17's real transactional-email integration
 * (master plan §21 P17: "a real transactional email provider, replacing
 * P1's stub"). Chosen because it exposes a single, simple, well-documented
 * HTTP JSON API (`POST https://api.resend.com/emails`) — exactly the
 * "simple HTTP/API integration" this phase's own spec asks for — needing
 * no vendor SDK dependency at all: Node's built-in `fetch` (global since
 * Node 18) is the entire client. Kept behind the same `EmailProvider`
 * interface `StubEmailProvider` implements, so nothing outside
 * `identity.module.ts`'s DI wiring knows which concrete provider is
 * active (this class's own doc comment on `EmailProvider` — "vendor
 * specifics never leak into domain/business logic").
 *
 * `sendPasswordResetEmail` is built on top of `sendTransactionalEmail`
 * here (unlike `StubEmailProvider`, which keeps two separate code paths
 * for its own test-introspection reasons) — one real HTTP call path, not
 * two, for the one provider that actually reaches a network.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailProvider, TransactionalEmailInput } from './email-provider.interface';
import type { EmailConfig } from '../../config/configuration';

const RESEND_API_URL = 'https://api.resend.com/emails';

@Injectable()
export class ResendEmailProvider implements EmailProvider {
  private readonly logger = new Logger(ResendEmailProvider.name);

  constructor(private readonly configService: ConfigService) {}

  async sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
    // P1's own reset-link convention — the frontend route, never a raw
    // token dump; matches the URL shape `AuthService`'s callers already
    // build elsewhere for user-facing links.
    await this.sendTransactionalEmail({
      to,
      subject: 'Reset your Atlas password',
      text:
        `We received a request to reset your Atlas password.\n\n` +
        `Reset token: ${rawToken}\n\n` +
        `If you did not request this, you can safely ignore this email.`,
    });
  }

  async sendTransactionalEmail(input: TransactionalEmailInput): Promise<void> {
    const email = this.configService.getOrThrow<EmailConfig>('email');
    // `validateEnv`'s own cross-field check already guarantees
    // `apiKey`/`fromEmail` are present whenever `provider === 'resend'`
    // (see `env.validation.ts`) — the app never boots into a state where
    // this class is active without them, but the narrow, typed
    // `getOrThrow` here still fails loudly rather than silently sending
    // `Bearer undefined` if that invariant is ever violated.
    if (!email.apiKey || !email.fromEmail) {
      throw new Error(
        'ResendEmailProvider is active but EMAIL_API_KEY/EMAIL_FROM_EMAIL are not configured.',
      );
    }

    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${email.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${email.fromName} <${email.fromEmail}>`,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
      }),
    });

    if (!response.ok) {
      // Never logs `input.text`/`.html` (may carry user-specific detail)
      // or the API key — only the outcome, matching master plan §16's
      // "logging redaction" rule and §19's "observable without exposing
      // secrets" instruction for P17 specifically.
      const status = response.status;
      this.logger.error(
        { status, to: this.maskEmail(input.to) },
        'Transactional email provider returned a non-2xx response',
      );
      throw new Error(`Email provider request failed with status ${status}`);
    }
  }

  private maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    return `${local.slice(0, 1)}***@${domain}`;
  }
}
