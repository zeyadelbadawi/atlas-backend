/**
 * The two P1/10.1 credential emails, composed in exactly one place.
 *
 * `EmailProviderRegistry.sendPasswordResetEmail`/`sendEmailVerification`
 * build their `send()` input here; `StubEmailProvider` recovers the token
 * from that same text for its test-only `peek*` helpers, so the wording is
 * a contract between these two files only. The tokens are live
 * credentials — they go into the message body and nowhere else (never a
 * tag, header or log).
 */
import type { EmailSendInput } from '../../identity/services/email-provider.interface';

export const PASSWORD_RESET_TAG = 'password_reset';
export const EMAIL_VERIFICATION_TAG = 'email_verification';

const RESET_MARKER = 'Reset token: ';
const VERIFY_MARKER = 'Verification token: ';

export function buildPasswordResetEmail(to: string, rawToken: string): EmailSendInput {
  // P1's own reset-link convention — the frontend route, never a raw
  // token dump; matches the URL shape `AuthService`'s callers already
  // build elsewhere for user-facing links.
  return {
    to,
    subject: 'Reset your Atlas password',
    text:
      `We received a request to reset your Atlas password.\n\n` +
      `${RESET_MARKER}${rawToken}\n\n` +
      `If you did not request this, you can safely ignore this email.`,
    category: 'security',
    tags: [PASSWORD_RESET_TAG],
  };
}

export function buildEmailVerificationEmail(
  to: string,
  rawToken: string,
): EmailSendInput {
  return {
    to,
    subject: 'Verify your Atlas email address',
    text:
      `Welcome to Atlas.\n\n` +
      `${VERIFY_MARKER}${rawToken}\n\n` +
      `If you did not create an Atlas account, you can safely ignore this email.`,
    category: 'security',
    tags: [EMAIL_VERIFICATION_TAG],
  };
}

function extractAfter(text: string, marker: string): string | undefined {
  const line = text.split('\n').find((candidate) => candidate.startsWith(marker));
  return line ? line.slice(marker.length).trim() || undefined : undefined;
}

export function extractPasswordResetToken(text: string): string | undefined {
  return extractAfter(text, RESET_MARKER);
}

export function extractEmailVerificationToken(text: string): string | undefined {
  return extractAfter(text, VERIFY_MARKER);
}
