/**
 * `TenantUsage` response contract — matches `TenantUsage` (`tenant.types.ts`)
 * field-for-field. Each `UsageMetric` pairs a raw `used` count (from the
 * `tenant_usage` table, refreshed only by the `tenant-usage-recompute`
 * worker) with a `limit` computed at READ time from the organization's
 * effective entitlements (`EntitlementService.computeEffectiveEntitlements`)
 * — the limit is never persisted alongside the usage count, so a plan
 * upgrade or add-on activation is reflected immediately on the next read,
 * without waiting for the next recompute cycle.
 */
import type { TenantUsage as PrismaTenantUsage } from '@prisma/client';
import type { EffectiveEntitlements, LimitValue } from './entitlement.types';

export interface UsageMetricResponse {
  readonly used: number;
  readonly limit: LimitValue;
}

export interface TenantUsageResponse {
  readonly organizationId: string;
  readonly academies: UsageMetricResponse;
  readonly students: UsageMetricResponse;
  readonly instructors: UsageMetricResponse;
  readonly staff: UsageMetricResponse;
  readonly courses: UsageMetricResponse;
  readonly generalStorage: UsageMetricResponse;
  readonly videoStorage: UsageMetricResponse;
  readonly updatedAt: string;
}

export function toTenantUsageResponse(
  usage: PrismaTenantUsage,
  entitlements: EffectiveEntitlements,
): TenantUsageResponse {
  return {
    organizationId: usage.organizationId,
    academies: { used: usage.academies, limit: entitlements.limits.academies },
    students: { used: usage.students, limit: entitlements.limits.students },
    instructors: { used: usage.instructors, limit: entitlements.limits.instructors },
    staff: { used: usage.staff, limit: entitlements.limits.staff },
    courses: { used: usage.courses, limit: entitlements.limits.courses },
    generalStorage: {
      used: usage.generalStorageGb,
      limit: entitlements.limits.generalStorage,
    },
    videoStorage: { used: usage.videoStorageGb, limit: entitlements.limits.videoStorage },
    updatedAt: usage.updatedAt.toISOString(),
  };
}
