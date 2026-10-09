/** Master plan §12: "Transactional email — Producer: Auth (verify/reset)... Consumer: email-worker." P1 scopes this to password-reset only; verification email is `SPECIFICATION-UNDEFINED` (§8/§24) and out of scope. */
export const PASSWORD_RESET_EMAIL_QUEUE = 'password-reset-email';

/**
 * ATO review F9 — the job a reset REQUEST enqueues: only the typed address
 * (normalised) and the host's academy. The account lookup, the token and
 * the email all happen in the worker, so the HTTP request does exactly the
 * same work for an address with an account as for one without, and no raw
 * token is ever stored in Redis.
 */
export interface PasswordResetRequestJobPayload {
  readonly kind: 'request';
  readonly email: string;
  readonly hostAcademyId?: string | null;
}

/**
 * The pre-F9 job (token minted in the request). Still processed, so a job
 * queued just before a deploy is delivered; nothing enqueues it any more.
 */
export interface LegacyPasswordResetEmailJobPayload {
  readonly kind?: undefined;
  readonly userId: string;
  readonly email: string;
  readonly rawToken: string;
  /** ISO-8601 — Date objects don't survive BullMQ's JSON serialization. */
  readonly expiresAt: string;
  /**
   * The academy the reset was requested on (from the request host), or
   * absent on the management host. A CANDIDATE only: the worker sends the
   * academy's email only when the account belongs to that academy
   * (`recoveryAcademyId`). Optional so jobs queued before this field
   * existed still process — as management resets, which they were.
   */
  readonly hostAcademyId?: string | null;
}

export type PasswordResetEmailJobPayload =
  PasswordResetRequestJobPayload | LegacyPasswordResetEmailJobPayload;
