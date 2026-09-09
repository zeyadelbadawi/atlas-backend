/**
 * Trial subject identity — the durable, pseudonymous key that decides
 * whether a Free Trial has already been consumed.
 *
 * WHY THIS IS SEPARATE FROM `normalizeEmail`. `identity/utils/email.util`
 * lowercases and trims, and that value backs login lookups and the
 * `users.email` unique constraint. It must NOT change: real accounts
 * already exist whose addresses differ only by a dot or a `+tag`, and
 * collapsing them there would merge or break live logins. Abuse
 * canonicalization is a strictly different question ("is this plausibly
 * the same mailbox?") answered by a strictly separate function, used only
 * for trial identity and never for authentication.
 *
 * WHAT IT DEFEATS. Plus-addressing (`me+1@`, `me+2@`, …) and, on
 * providers that genuinely ignore them, dots (`f.i.r.s.t@gmail.com`).
 * Both are the cheapest possible way to mint "new" addresses from one
 * real mailbox, and both are free to the abuser.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not treat two different
 * domains as the same subject, and it does not try to decide that two
 * different mailboxes belong to one human — no technical signal can
 * establish that, and guessing would block legitimate colleagues who each
 * sign up from the same company.
 *
 * PRIVACY. Only a SHA-256 digest is ever persisted, never the address.
 * The digest is domain-separated by a fixed application salt so it cannot
 * be trivially cross-referenced against a hash of the same address
 * computed elsewhere. The salt is a CONSTANT, not a rotatable secret,
 * and that is deliberate: trial-redemption history has to outlive secret
 * rotation, and a rotated pepper would silently hand every past abuser a
 * fresh trial.
 */
import { createHash } from 'node:crypto';

/**
 * Domain-separation salt. Changing this value invalidates every existing
 * trial-redemption record and re-grants trials to everyone who has
 * already used one. Treat it as frozen.
 */
const TRIAL_SUBJECT_SALT = 'atlas.trial.subject.v1';

/**
 * Providers that genuinely deliver `f.i.r.s.t@` and `first@` to the same
 * mailbox. Kept deliberately short and specific: applying dot-collapsing
 * to a provider that treats dots as significant would merge two genuinely
 * different people into one trial subject, which is a far worse failure
 * than missing one abuse vector.
 */
const DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Providers where everything after `+` is a user-chosen tag on one real mailbox. Nearly universal, but still enumerated rather than assumed. */
const PLUS_ADDRESSING_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'proton.me',
  'protonmail.com',
  'icloud.com',
  'me.com',
  'fastmail.com',
  'zoho.com',
]);

/**
 * Collapses an address to the mailbox it plausibly delivers to.
 *
 * Returns a canonical `local@domain` string. Exported for testing and for
 * the disposable-domain check, which needs the same domain extraction.
 */
export function canonicalizeEmailForAbuse(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf('@');
  // Not a shape we can reason about — hash it verbatim rather than
  // throwing. Validation is the DTO layer's job; this function must never
  // be the thing that rejects a signup.
  if (atIndex <= 0) return trimmed;

  let local = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1);

  if (PLUS_ADDRESSING_DOMAINS.has(domain)) {
    const plusIndex = local.indexOf('+');
    if (plusIndex > 0) local = local.slice(0, plusIndex);
  }

  if (DOT_INSENSITIVE_DOMAINS.has(domain)) {
    local = local.split('.').join('');
  }

  return `${local}@${domain}`;
}

/** The domain portion, lowercased — the unit the disposable-domain check operates on. */
export function emailDomain(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf('@');
  return atIndex > 0 ? trimmed.slice(atIndex + 1) : '';
}

/**
 * The value stored in `trial_redemptions.subject_hash`.
 *
 * One-way by construction: the address cannot be recovered from it, so a
 * database disclosure reveals only that *some* address consumed a trial,
 * not whose.
 */
export function trialSubjectHash(email: string): string {
  const canonical = canonicalizeEmailForAbuse(email);
  return createHash('sha256').update(`${TRIAL_SUBJECT_SALT}:${canonical}`).digest('hex');
}
