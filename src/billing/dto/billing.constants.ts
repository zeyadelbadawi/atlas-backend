/**
 * Billing & Payment constants (master plan §21 Phase P12).
 *
 * `MAX_PAYMENT_PROOF_FILE_SIZE`/`ALLOWED_PAYMENT_PROOF_MIME_TYPES`/
 * `MIN_PAYMENT_REJECTION_NOTES_LENGTH`/`MAX_PAYMENT_REVIEW_NOTES_LENGTH`/
 * `MAX_PAYMENT_PROOF_NOTE_LENGTH` mirror the real frontend's own
 * `features/billing/constants/billing.constants.ts` values exactly — these
 * are not re-derived or re-guessed, they are the same numbers the frontend
 * form validation already enforces (`billing.schemas.ts`), enforced again
 * here server-side per master plan §16's blanket rule ("never trust the
 * client alone").
 *
 * `CHECKOUT_EXPIRY_MINUTES`/`ATLAS_MANUAL_PROVIDER_KEY` are backend-owned
 * values with no frontend counterpart to mirror — see this module's own
 * P12 implementation report for why 30 minutes was chosen (a reasonable,
 * documented default, not a value pulled from any specification).
 */

/** Payment proof maximum file size — matches the frontend's own 10MB ceiling (larger than the 5MB image-only Course thumbnail limit, since proof also accepts PDF bank receipts). */
export const MAX_PAYMENT_PROOF_FILE_SIZE = 10 * 1024 * 1024;

/** Allowed payment proof MIME types — matches the frontend's own `ALLOWED_PAYMENT_PROOF_TYPES` exactly (a narrower allowlist than `media`'s general five-type set: no gif/webp for a bank-transfer proof). */
export const ALLOWED_PAYMENT_PROOF_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'application/pdf',
];

/** Payment review rejection notes: minimum length — matches the frontend's own floor (a reviewer must give the tenant an actionable reason). */
export const MIN_PAYMENT_REJECTION_NOTES_LENGTH = 10;
export const MAX_PAYMENT_REVIEW_NOTES_LENGTH = 1000;
export const MAX_PAYMENT_PROOF_NOTE_LENGTH = 500;

/**
 * How long a Checkout stays payable after creation before it is treated as
 * expired. No frontend contract or master plan section specifies a
 * duration — this is a reasonable, narrow, documented default (matching
 * the existing `PASSWORD_RESET_TOKEN_TTL_MINUTES=45`-style precedent for
 * "a short-lived window with no specified number"), not a fabricated
 * business rule. Flagged in the P12 implementation report as a
 * product-decision-shaped default a real Atlas billing product owner
 * should confirm or override.
 */
export const CHECKOUT_EXPIRY_MINUTES = 30;

/** The one registered `PaymentProviderAdapter` key — matches the frontend's `ManualTransferProvider.providerKey`/`PaymentProviderRegistry` exactly. */
export const ATLAS_MANUAL_PROVIDER_KEY = 'atlas_manual';
