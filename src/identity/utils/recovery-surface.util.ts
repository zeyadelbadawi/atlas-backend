/**
 * Production QA Issue 5 — which surface a password-reset email sends its
 * reader back to.
 *
 * The request host decides the CANDIDATE: a reset asked for on an academy
 * website names that academy; on the management host (or a local or
 * unknown host) there is none. The account decides whether the candidate
 * stands: only an account that already belongs to that academy — a
 * student row (any status; a blocked learner is refused at sign-in, where
 * that rule already lives) or an active staff row — is sent to the
 * academy's own reset page and gets the academy's branding. Anyone else
 * gets the management email, exactly as before.
 *
 * Deliberately NOT here: any change to membership. A reset rotates a
 * password and nothing else; the academy sign-in the reset page leads to
 * still applies every admission rule. And because the reset request is
 * answered identically whatever this returns (it runs in the email worker,
 * after the response), it is not an oracle for "does this address belong
 * to this academy".
 */
import type { Principal } from '../../tenancy/services/principal-resolver.service';

export function recoveryAcademyId(
  principal: Pick<Principal, 'academies' | 'academyStaff'>,
  hostAcademyId: string | null | undefined,
): string | null {
  if (!hostAcademyId) return null;
  const belongs =
    principal.academies.some((academy) => academy.academyId === hostAcademyId) ||
    principal.academyStaff.some((row) => row.academyId === hostAcademyId);
  return belongs ? hostAcademyId : null;
}
