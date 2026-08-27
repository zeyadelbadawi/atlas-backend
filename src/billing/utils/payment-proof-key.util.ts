/** A safe, backend-generated storage key for a payment proof — the client never supplies any part of it, mirroring `media/utils/file-validation.util.ts`'s `buildStorageKey`/`sanitizeFileName` precedent (organization-scoped here, not academy-scoped). */
export function buildPaymentProofStorageKey(
  organizationId: string,
  paymentId: string,
  extension: string,
  id: string,
): string {
  return `organizations/${organizationId}/payments/${paymentId}/${id}.${extension}`;
}

/** Phase P13 — the Course Commerce analog for a course-order Payment's proof, which has no `organizationId` (it carries `payeeAcademyId` instead, per §5.7's extension point) — keyed by Academy, mirroring `media_assets`' own `academies/{academyId}/...` storage-key convention (§13) rather than inventing a third shape. */
export function buildCourseOrderPaymentProofStorageKey(
  academyId: string,
  paymentId: string,
  extension: string,
  id: string,
): string {
  return `academies/${academyId}/course-order-payments/${paymentId}/${id}.${extension}`;
}
