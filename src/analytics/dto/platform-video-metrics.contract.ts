/**
 * `GET /platform-metrics/video` — the Platform Owner's video-minutes and
 * provider-health view (P64 Phase 4 §E.5). A SEPARATE response from the
 * fixed seven-KPI `PlatformMetricsOverviewResponse`, whose contract
 * deliberately forbids new fields. Counts and minutes only — no tenant
 * names, no asset ids.
 */

export interface PlatformVideoTierMetricResponse {
  /** `normal` | `premium`; `none` for video assets with no tier assigned yet. */
  readonly tier: 'normal' | 'premium' | 'none';
  readonly assets: number;
  readonly storedMinutes: number;
  readonly storedGb: number;
}

export interface PlatformVideoMetricsResponse {
  readonly totalVideoAssets: number;
  readonly totalStoredMinutes: number;
  readonly totalStoredGb: number;
  readonly byTier: readonly PlatformVideoTierMetricResponse[];
  /** Per `MediaAssetProvider` (`r2` | `r2_worker` | `cloudflare_stream`). */
  readonly byProvider: Readonly<Record<string, number>>;
  /** Per `MediaProcessingStatus` — a growing `failed`/`processing` count is the provider-health signal. */
  readonly processing: {
    readonly pending: number;
    readonly processing: number;
    readonly ready: number;
    readonly failed: number;
  };
  readonly generatedAt: string;
}
