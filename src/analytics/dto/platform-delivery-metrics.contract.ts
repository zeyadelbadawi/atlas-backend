/**
 * `GET /platform-metrics/delivery?days=` — the Platform Owner's content
 * delivery / retention view (P64 Phase 4 §E.5): protected-content access
 * decisions, the video inventory (`GET /platform-metrics/video` verbatim),
 * and how much retention-expired data is still waiting for the Phase 2
 * maintenance sweep. Counts only — no user, device, session, course or
 * academy ids.
 */
import type { PlatformVideoMetricsResponse } from './platform-video-metrics.contract';

export interface PlatformDeliveryGrantCountsResponse {
  /** `content_access_log` rows with `result = granted` and `created_at` inside the window. */
  readonly granted: number;
  /** ...with `result = refused`. */
  readonly refused: number;
  /** Refusals keyed by their closed-vocabulary `reason` (`ContentAccessReason`: `notEnrolled`, `locked`, `deviceLimit`, `sessionConflict`, ...); a refusal with no reason is keyed `other`. */
  readonly refusedByReason: Readonly<Record<string, number>>;
  /** True when the window held more than 50 000 rows — the counts then cover only the 50 000 most recent. */
  readonly truncated: boolean;
}

export interface PlatformDeliveryRetentionResponse {
  /** `content_access_log` rows older than `CONTENT_ACCESS_LOG_RETENTION_DAYS` (90) still present — an honest "pending prune" signal; non-zero for long means the sweep is not running. */
  readonly contentAccessLogRowsPastWindow: number;
  /** `quiz_attempt_events` rows older than `QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS` (180) still present. */
  readonly quizAttemptEventsPastWindow: number;
}

export interface PlatformDeliveryMetricsResponse {
  /** The `days` the caller asked for (1–90, default 30). Applies to `grants` only — `video` is a live inventory and `retention` uses the fixed retention windows. */
  readonly windowDays: number;
  readonly grants: PlatformDeliveryGrantCountsResponse;
  /** Exactly `GET /platform-metrics/video`'s response, computed in the same request. */
  readonly video: PlatformVideoMetricsResponse;
  readonly retention: PlatformDeliveryRetentionResponse;
  readonly generatedAt: string;
}
