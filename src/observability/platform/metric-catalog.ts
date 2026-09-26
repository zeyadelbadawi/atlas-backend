/**
 * The ONLY queries the Observability Center can run. The browser asks for a
 * metric by id; it can never send PromQL. Each entry names the series it
 * depends on (`requires`), so a metric whose series does not exist is
 * reported `available: false` rather than drawn as a flat zero.
 */
import type { MetricDomain, MetricUnit } from './observability.contract';

export interface MetricEntry {
  readonly id: string;
  readonly domain: MetricDomain;
  readonly unit: MetricUnit;
  readonly requires: string;
  /** `$__range_step` is replaced by the window used for rate()/increase(). */
  readonly expr: string;
}

const R = '$__rate';

export const METRIC_CATALOG: readonly MetricEntry[] = [
  {
    id: 'api.requestRate',
    domain: 'api',
    unit: 'perSecond',
    requires: 'atlas_http_requests_total',
    expr: `sum(rate(atlas_http_requests_total[${R}]))`,
  },
  {
    id: 'api.errorRate5xx',
    domain: 'api',
    unit: 'percent',
    requires: 'atlas_http_requests_total',
    expr: `sum(rate(atlas_http_requests_total{status_class="5xx"}[${R}])) / clamp_min(sum(rate(atlas_http_requests_total[${R}])), 1e-9)`,
  },
  {
    id: 'api.errorRate4xx',
    domain: 'api',
    unit: 'percent',
    requires: 'atlas_http_requests_total',
    expr: `sum(rate(atlas_http_requests_total{status_class="4xx"}[${R}])) / clamp_min(sum(rate(atlas_http_requests_total[${R}])), 1e-9)`,
  },
  {
    id: 'api.latencyP50',
    domain: 'api',
    unit: 'seconds',
    requires: 'atlas_http_request_duration_seconds_bucket',
    expr: `histogram_quantile(0.5, sum by (le) (rate(atlas_http_request_duration_seconds_bucket[${R}])))`,
  },
  {
    id: 'api.latencyP95',
    domain: 'api',
    unit: 'seconds',
    requires: 'atlas_http_request_duration_seconds_bucket',
    expr: `histogram_quantile(0.95, sum by (le) (rate(atlas_http_request_duration_seconds_bucket[${R}])))`,
  },
  {
    id: 'api.latencyP99',
    domain: 'api',
    unit: 'seconds',
    requires: 'atlas_http_request_duration_seconds_bucket',
    expr: `histogram_quantile(0.99, sum by (le) (rate(atlas_http_request_duration_seconds_bucket[${R}])))`,
  },
  {
    id: 'database.probeLatency',
    domain: 'database',
    unit: 'seconds',
    requires: 'atlas_dependency_latency_seconds',
    expr: 'atlas_dependency_latency_seconds{dependency="database"}',
  },
  {
    id: 'database.up',
    domain: 'database',
    unit: 'count',
    requires: 'atlas_dependency_up',
    expr: 'atlas_dependency_up{dependency="database"}',
  },
  {
    id: 'redis.probeLatency',
    domain: 'redis',
    unit: 'seconds',
    requires: 'atlas_dependency_latency_seconds',
    expr: 'atlas_dependency_latency_seconds{dependency="redis"}',
  },
  {
    id: 'redis.usedMemory',
    domain: 'redis',
    unit: 'bytes',
    requires: 'atlas_redis_used_memory_bytes',
    expr: 'atlas_redis_used_memory_bytes',
  },
  {
    id: 'redis.connectedClients',
    domain: 'redis',
    unit: 'count',
    requires: 'atlas_redis_connected_clients',
    expr: 'atlas_redis_connected_clients',
  },
  {
    id: 'jobs.waiting',
    domain: 'jobs',
    unit: 'count',
    requires: 'atlas_queue_jobs',
    expr: 'sum by (queue) (atlas_queue_jobs{state="waiting"})',
  },
  {
    id: 'jobs.active',
    domain: 'jobs',
    unit: 'count',
    requires: 'atlas_queue_jobs',
    expr: 'sum by (queue) (atlas_queue_jobs{state="active"})',
  },
  {
    id: 'jobs.failed',
    domain: 'jobs',
    unit: 'count',
    requires: 'atlas_queue_jobs',
    expr: 'sum by (queue) (atlas_queue_jobs{state="failed"})',
  },
  {
    id: 'jobs.delayed',
    domain: 'jobs',
    unit: 'count',
    requires: 'atlas_queue_jobs',
    expr: 'sum by (queue) (atlas_queue_jobs{state="delayed"})',
  },
  {
    id: 'video.uploadCompletions',
    domain: 'video',
    unit: 'perSecond',
    requires: 'atlas_video_upload_completions_total',
    expr: `sum by (result) (rate(atlas_video_upload_completions_total[${R}]))`,
  },
  {
    id: 'video.tokenMintP95',
    domain: 'video',
    unit: 'ms',
    requires: 'atlas_video_token_mint_duration_ms_bucket',
    expr: `histogram_quantile(0.95, sum by (le) (rate(atlas_video_token_mint_duration_ms_bucket[${R}])))`,
  },
  {
    id: 'video.webhookSignatureFailures',
    domain: 'video',
    unit: 'perSecond',
    requires: 'atlas_video_webhook_signature_failures_total',
    expr: `sum(rate(atlas_video_webhook_signature_failures_total[${R}]))`,
  },
  {
    id: 'video.grantsIssued',
    domain: 'video',
    unit: 'perSecond',
    requires: 'atlas_content_grants_total',
    expr: `sum by (result) (rate(atlas_content_grants_total[${R}]))`,
  },
  {
    id: 'email.outboxOldestPending',
    domain: 'email',
    unit: 'seconds',
    requires: 'atlas_comm_outbox_oldest_pending_seconds',
    expr: 'max(atlas_comm_outbox_oldest_pending_seconds)',
  },
  {
    id: 'email.outboxByState',
    domain: 'email',
    unit: 'perSecond',
    requires: 'atlas_comm_outbox_total',
    expr: `sum by (state) (rate(atlas_comm_outbox_total[${R}]))`,
  },
  {
    id: 'email.deadLetters',
    domain: 'email',
    unit: 'perSecond',
    requires: 'atlas_comm_dead_letter_total',
    expr: `sum(rate(atlas_comm_dead_letter_total[${R}]))`,
  },
  {
    id: 'email.dispatchLatencyP95',
    domain: 'email',
    unit: 'seconds',
    requires: 'atlas_comm_dispatch_latency_seconds_bucket',
    expr: `histogram_quantile(0.95, sum by (le) (rate(atlas_comm_dispatch_latency_seconds_bucket[${R}])))`,
  },
  {
    id: 'email.retries',
    domain: 'email',
    unit: 'perSecond',
    requires: 'atlas_comm_retry_attempts_total',
    expr: `sum(rate(atlas_comm_retry_attempts_total[${R}]))`,
  },
  {
    id: 'learning.quizStarted',
    domain: 'learning',
    unit: 'perSecond',
    requires: 'atlas_quiz_attempts_started_total',
    expr: `sum(rate(atlas_quiz_attempts_started_total[${R}]))`,
  },
  {
    id: 'learning.quizSubmitted',
    domain: 'learning',
    unit: 'perSecond',
    requires: 'atlas_quiz_attempts_submitted_total',
    expr: `sum(rate(atlas_quiz_attempts_submitted_total[${R}]))`,
  },
  {
    id: 'learning.integrityEvents',
    domain: 'learning',
    unit: 'perSecond',
    requires: 'atlas_quiz_integrity_events_total',
    expr: `sum by (type) (rate(atlas_quiz_integrity_events_total[${R}]))`,
  },
  {
    id: 'learning.certificatesIssued',
    domain: 'learning',
    unit: 'perSecond',
    requires: 'atlas_certificates_issued_total',
    expr: `sum(rate(atlas_certificates_issued_total[${R}]))`,
  },
  {
    id: 'commerce.ordersByState',
    domain: 'commerce',
    unit: 'perSecond',
    requires: 'atlas_checkout_orders_total',
    expr: `sum by (state) (rate(atlas_checkout_orders_total[${R}]))`,
  },
  {
    id: 'commerce.approvalLatencyP95',
    domain: 'commerce',
    unit: 'seconds',
    requires: 'atlas_checkout_approval_latency_seconds_bucket',
    expr: `histogram_quantile(0.95, sum by (le) (rate(atlas_checkout_approval_latency_seconds_bucket[${R}])))`,
  },
  {
    id: 'catalog.queryP95',
    domain: 'catalog',
    unit: 'ms',
    requires: 'atlas_public_catalog_query_duration_ms_bucket',
    expr: `histogram_quantile(0.95, sum by (le) (rate(atlas_public_catalog_query_duration_ms_bucket[${R}])))`,
  },
  {
    id: 'retention.sweepRuns',
    domain: 'retention',
    unit: 'perSecond',
    requires: 'atlas_retention_sweep_runs_total',
    expr: `sum by (table, result) (rate(atlas_retention_sweep_runs_total[${R}]))`,
  },
  {
    id: 'retention.prunedRows',
    domain: 'retention',
    unit: 'perSecond',
    requires: 'atlas_retention_sweep_pruned_rows_total',
    expr: `sum by (table) (rate(atlas_retention_sweep_pruned_rows_total[${R}]))`,
  },
  {
    id: 'process.eventLoopLag',
    domain: 'process',
    unit: 'seconds',
    requires: 'nodejs_eventloop_lag_seconds',
    expr: 'max(nodejs_eventloop_lag_seconds)',
  },
  {
    id: 'process.residentMemory',
    domain: 'process',
    unit: 'bytes',
    requires: 'process_resident_memory_bytes',
    expr: 'sum(process_resident_memory_bytes{job="atlas-backend"})',
  },
  {
    id: 'process.cpu',
    domain: 'process',
    unit: 'perSecond',
    requires: 'process_cpu_seconds_total',
    expr: `sum(rate(process_cpu_seconds_total{job="atlas-backend"}[${R}]))`,
  },
  {
    id: 'alerting.notificationsSent',
    domain: 'alerting',
    unit: 'perSecond',
    requires: 'alertmanager_notifications_total',
    expr: `sum by (integration) (rate(alertmanager_notifications_total[${R}]))`,
  },
  {
    id: 'alerting.notificationsFailed',
    domain: 'alerting',
    unit: 'perSecond',
    requires: 'alertmanager_notifications_failed_total',
    expr: `sum by (integration) (rate(alertmanager_notifications_failed_total[${R}]))`,
  },
];

export const RATE_TOKEN = R;
