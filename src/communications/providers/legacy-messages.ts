/**
 * Recovering a live credential from a sent email — TEST SUPPORT ONLY.
 *
 * The password-reset and email-verification emails no longer paste their
 * token into the body. They used to:
 *
 *     Reset token: 9f2c1e...
 *
 * which handed the recipient an internal credential with no action
 * attached — a dead end, and the exact shape a phishing lookalike
 * imitates. Both now go through `CommunicationService.emit` and render
 * the catalogue's bilingual template with a CTA button, so the token
 * travels INSIDE the href and is never displayed.
 *
 * `StubEmailProvider` still needs to recover it so the e2e suites can
 * follow the link the way a person would, so the extractors below parse
 * the `token` query parameter out of the rendered URL instead of a
 * marker line. That keeps the test harness following the real contract
 * rather than a private one it shares with a builder that no longer
 * exists.
 *
 * The two `*_TAG` constants remain because the stub still uses them to
 * classify a send, and `EmailSendInput.tags` still carries them for the
 * legacy interface methods.
 */
export const PASSWORD_RESET_TAG = 'password_reset';
export const EMAIL_VERIFICATION_TAG = 'email_verification';

/** Catalogue keys, as `EmailTransport` flattens them into a tag. */
export const PASSWORD_RESET_EVENT_TAG = 'key:auth.password.reset';
export const EMAIL_VERIFICATION_EVENT_TAG = 'key:auth.email.verification';

/**
 * Pulls `?token=...` out of the first URL in the message that points at
 * `path`. Deliberately scoped to the expected destination: a body that
 * happens to contain some other link cannot be mistaken for the one the
 * flow depends on, and a token that appears anywhere OUTSIDE a URL is
 * not found — which is what makes this an honest check that the value is
 * only ever in the href.
 */
function extractTokenFromLink(text: string, path: string): string | undefined {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    if (!url.pathname.endsWith(path)) continue;
    const token = url.searchParams.get('token');
    if (token) return token;
  }
  return undefined;
}

export function extractPasswordResetToken(text: string): string | undefined {
  return extractTokenFromLink(text, '/auth/reset-password');
}

/**
 * Matches both destinations `auth.email.verification` builds: the
 * management host's `/auth/verify-email` and an academy host's
 * root-mounted `/verify-email` (optionally under `/ar`).
 */
export function extractEmailVerificationToken(text: string): string | undefined {
  return extractTokenFromLink(text, '/verify-email');
}
