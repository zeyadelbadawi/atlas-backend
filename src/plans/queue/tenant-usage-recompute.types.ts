/** Master plan §12/§21 Phase P4: "Workers: tenant-usage-recompute (scheduled)." See `TenantUsageRecomputeService`'s doc comment for this queue's per-organization scope boundary. */
export const TENANT_USAGE_RECOMPUTE_QUEUE = 'tenant-usage-recompute';

export const RECOMPUTE_ONE_JOB = 'recompute-one';

export interface RecomputeOneJobPayload {
  readonly organizationId: string;
}
