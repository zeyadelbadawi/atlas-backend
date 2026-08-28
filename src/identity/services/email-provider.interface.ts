/**
 * `sendPasswordResetEmail` is P1's original, narrow surface — left exactly
 * as-is (never rewritten) to avoid touching P1's already-working flow.
 *
 * `sendTransactionalEmail` is Phase P17's own, generic addition — the
 * `TransactionalEmailProvider` layer of the `NotificationService →
 * EmailService → TransactionalEmailProvider → Provider API` architecture
 * this phase's own spec calls for. Deliberately thin: it knows nothing
 * about templates, preferences, or *why* an email is being sent — only
 * "send this already-resolved subject/body to this address." All of that
 * business knowledge lives one layer up, in `EmailService`
 * (`src/notification-events/services/email.service.ts`), which is the
 * only caller of this method — never `NotificationFanoutService`/any
 * domain service directly (this interface's own doc comment is the
 * enforcement of "do NOT make NotificationService call a vendor SDK
 * everywhere").
 */
export interface TransactionalEmailInput {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface EmailProvider {
  sendPasswordResetEmail(to: string, rawToken: string): Promise<void>;
  sendTransactionalEmail(input: TransactionalEmailInput): Promise<void>;
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
