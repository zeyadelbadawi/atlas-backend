/**
 * Platform Owner Observability Center — response contracts.
 *
 * Every value here comes from a real source: live dependency probes, the
 * process metrics registry, Prometheus (queries, rules, `ALERTS` history)
 * and Alertmanager (current alerts, receivers). When a source is not
 * reachable or not configured the contract SAYS SO (`source` fields,
 * `status: 'unknown' | 'not_configured'`, `available: false`) instead of
 * inventing a value. Nothing here ever carries a secret.
 */

export type SourceState = 'ok' | 'unavailable' | 'not_configured';

export type ComponentKey =
  | 'api'
  | 'database'
  | 'redis'
  | 'queues'
  | 'email'
  | 'video'
  | 'storage'
  | 'prometheus'
  | 'alertmanager';

export type ComponentStatus =
  'healthy' | 'degraded' | 'down' | 'unknown' | 'not_configured';

export type DetailUnit = 'ms' | 'seconds' | 'percent' | 'count' | 'bytes' | 'text';

export interface ComponentDetail {
  /** Stable key the UI translates (e.g. `p95LatencyMs`, `failedJobs`). */
  readonly key: string;
  readonly value: number | string | null;
  readonly unit: DetailUnit;
}

export interface ComponentHealth {
  readonly key: ComponentKey;
  readonly status: ComponentStatus;
  readonly checkedAt: string;
  /** Round-trip of the probe itself, when the component was probed. */
  readonly latencyMs: number | null;
  readonly details: readonly ComponentDetail[];
  /** Stable reason key when not healthy (e.g. `probeFailed`, `backlog`). */
  readonly reason: string | null;
}

export interface SystemHealthResponse {
  readonly generatedAt: string;
  readonly overall: 'operational' | 'degraded' | 'outage';
  readonly alerts: {
    readonly source: SourceState;
    readonly active: number;
    readonly critical: number;
    readonly warning: number;
    readonly info: number;
  };
  readonly components: readonly ComponentHealth[];
}

export type AlertSeverity = 'critical' | 'warning' | 'info' | 'unknown';
export type AlertStatus = 'firing' | 'pending' | 'silenced' | 'resolved';

export interface AffectedTenant {
  readonly organizationId: string | null;
  readonly academyId: string | null;
  readonly name: string | null;
}

export interface AlertItem {
  /** Stable id of this alert instance (rule + label set). */
  readonly id: string;
  readonly rule: string;
  readonly severity: AlertSeverity;
  readonly status: AlertStatus;
  readonly summary: string | null;
  readonly description: string | null;
  readonly service: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly startsAt: string;
  /** Null while still active. */
  readonly endsAt: string | null;
  readonly durationSeconds: number;
  /** Only tenants named by the alert's own labels — never inferred. */
  readonly affectedTenants: readonly AffectedTenant[];
}

export interface AlertsResponse {
  readonly generatedAt: string;
  readonly sources: {
    readonly alertmanager: SourceState;
    readonly prometheus: SourceState;
  };
  /** How far back history reaches (Prometheus retention bounds it). */
  readonly historyFrom: string;
  readonly items: readonly AlertItem[];
}

export interface AlertRuleInfo {
  readonly name: string;
  readonly group: string;
  readonly expression: string;
  readonly forSeconds: number;
  readonly severity: AlertSeverity;
  readonly service: string | null;
  readonly summary: string | null;
  readonly description: string | null;
  /** Human-readable threshold from the rule's own `threshold` annotation. */
  readonly threshold: string | null;
  readonly state: 'firing' | 'pending' | 'inactive';
  readonly health: 'ok' | 'err' | 'unknown';
  readonly lastError: string | null;
  readonly lastEvaluation: string | null;
  readonly lastTriggeredAt: string | null;
  readonly lastResolvedAt: string | null;
  /** Rules live in version-controlled config; the UI never edits them. */
  readonly editable: false;
}

export interface TimelineEvent {
  readonly at: string;
  readonly kind: 'triggered' | 'resolved' | 'pending';
  readonly alertId: string;
}

export interface SeriesPoint {
  readonly t: string;
  readonly v: number | null;
}

export interface Series {
  readonly labels: Readonly<Record<string, string>>;
  readonly points: readonly SeriesPoint[];
}

export interface AlertRuleDetailResponse {
  readonly generatedAt: string;
  readonly sources: {
    readonly alertmanager: SourceState;
    readonly prometheus: SourceState;
  };
  readonly rule: AlertRuleInfo;
  /** Current value of the rule's expression, per series (instant query). */
  readonly currentValues: readonly {
    readonly labels: Readonly<Record<string, string>>;
    readonly value: number | null;
  }[];
  readonly instances: readonly AlertItem[];
  readonly timeline: readonly TimelineEvent[];
  /** The rule's own expression over the selected window. */
  readonly expressionSeries: readonly Series[];
}

export type MetricDomain =
  | 'api'
  | 'database'
  | 'redis'
  | 'jobs'
  | 'video'
  | 'email'
  | 'learning'
  | 'commerce'
  | 'catalog'
  | 'retention'
  | 'process'
  | 'alerting';

export type MetricUnit = 'perSecond' | 'percent' | 'seconds' | 'ms' | 'bytes' | 'count';

export interface MetricDefinition {
  readonly id: string;
  readonly domain: MetricDomain;
  readonly unit: MetricUnit;
  /** False when the underlying series does not exist (not instrumented / not scraped). */
  readonly available: boolean;
}

export interface MetricCatalogResponse {
  readonly generatedAt: string;
  readonly source: SourceState;
  readonly metrics: readonly MetricDefinition[];
}

export type MetricRange = '1h' | '6h' | '24h' | '7d' | '30d';

export interface MetricSeriesResponse {
  readonly generatedAt: string;
  readonly source: SourceState;
  readonly metric: MetricDefinition;
  readonly from: string;
  readonly to: string;
  readonly stepSeconds: number;
  readonly series: readonly Series[];
}

export interface NotificationChannel {
  readonly kind: 'slack';
  /** Whether Alertmanager has a Slack receiver configured (never the URL). */
  readonly configured: boolean;
  readonly source: SourceState;
  /** From Alertmanager's own notification counters, last 24 h. */
  readonly sent24h: number | null;
  readonly failed24h: number | null;
}

export interface MonitoringConfigurationResponse {
  readonly generatedAt: string;
  readonly sources: {
    readonly alertmanager: SourceState;
    readonly prometheus: SourceState;
  };
  readonly scrapeAuthentication: 'token' | 'platform_owner_only';
  readonly rules: readonly AlertRuleInfo[];
  readonly channels: readonly NotificationChannel[];
  readonly syntheticAlert: SyntheticAlertState;
}

export interface SyntheticAlertState {
  readonly armed: boolean;
  readonly armedAt: string | null;
  readonly expiresAt: string | null;
  readonly armedBy: string | null;
}
