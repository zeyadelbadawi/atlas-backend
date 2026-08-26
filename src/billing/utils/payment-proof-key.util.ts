/** A safe, backend-generated storage key for a payment proof — the client never supplies any part of it, mirroring `media/utils/file-validation.util.ts`'s `buildStorageKey`/`sanitizeFileName` precedent (organization-scoped here, not academy-scoped). */
export function buildPaymentProofStorageKey(
  organizationId: string,
  paymentId: string,
  extension: string,
  id: string,
): string {
  return `organizations/${organizationId}/payments/${paymentId}/${id}.${extension}`;
}
