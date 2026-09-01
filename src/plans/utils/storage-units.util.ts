/**
 * Storage-unit conversion — the ONE place a raw `MediaAsset.sizeBytes`
 * total is turned into the whole-GB integer `tenant_usage.generalStorageGb`/
 * `videoStorageGb` (and their matching `PlanResourceLimits` entries) are
 * expressed in. Used by both `TenantUsageRecomputeService` (the cached
 * `tenant_usage` row) and `EntitlementEnforcementService` (the live,
 * write-time check) — a single shared conversion so the two can never
 * silently disagree on what "1 GB" means.
 *
 * Decimal GB (10^9 bytes), not binary GiB (2^30) — matches the plain
 * customer-facing "GB" unit every Plan's `generalStorage`/`videoStorage`
 * limit is already displayed in (`entitlement.utils.ts`'s
 * `formatLimitValue`, atlas frontend), never a storage-vendor binary
 * convention the UI never mentions.
 *
 * Rounds UP, never down or to nearest: a tenant at 2.1 GB of usage against
 * a 2 GB limit has already exceeded it, matching how cloud storage quotas
 * are conventionally billed/enforced (any partial GB counts as a whole
 * one), and — critically — ensures a non-empty upload can never compute to
 * `0` used GB and silently evade a `1 GB` (or any) limit.
 */

export const BYTES_PER_GB = 1_000_000_000;

/** Converts a byte total (as returned by a Prisma `BigInt`/`_sum` aggregate, possibly `null` for "no rows") into whole, rounded-up GB. */
export function bytesToGb(totalBytes: bigint | number | null | undefined): number {
  if (totalBytes === null || totalBytes === undefined) return 0;
  const bytes = typeof totalBytes === 'bigint' ? Number(totalBytes) : totalBytes;
  if (bytes <= 0) return 0;
  return Math.ceil(bytes / BYTES_PER_GB);
}
