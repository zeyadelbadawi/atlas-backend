/** Matches `TenantUsageRecomputeProducer`'s queue-constant precedent exactly. */
export const MEDIA_PROCESSING_QUEUE = 'media-processing';
export const PROCESS_MEDIA_ASSET_JOB = 'process-media-asset';

export interface ProcessMediaAssetJobPayload {
  readonly mediaAssetId: string;
  readonly academyId: string;
  /** Needed separately from `academyId` — `TenancyContextService.runInTenantContext` sets `app.current_organization_id`, not an academy id; the worker runs outside any request, so nothing else can resolve it. */
  readonly organizationId: string;
}
