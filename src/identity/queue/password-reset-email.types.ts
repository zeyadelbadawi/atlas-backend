/** Master plan §12: "Transactional email — Producer: Auth (verify/reset)... Consumer: email-worker." P1 scopes this to password-reset only; verification email is `SPECIFICATION-UNDEFINED` (§8/§24) and out of scope. */
export const PASSWORD_RESET_EMAIL_QUEUE = 'password-reset-email';

export interface PasswordResetEmailJobPayload {
  readonly userId: string;
  readonly email: string;
  readonly rawToken: string;
  /** ISO-8601 — Date objects don't survive BullMQ's JSON serialization. */
  readonly expiresAt: string;
}
