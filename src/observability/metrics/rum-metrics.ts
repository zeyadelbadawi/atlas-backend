/**
 * Real-user monitoring (P6) — Core Web Vitals as Prometheus histograms on
 * `METRICS_REGISTRY`, scraped by the self-hosted Prometheus with the rest.
 * Labels are the closed vocabularies of `web-vitals.util.ts` (13 routes ×
 * 2 devices), so the series count is fixed. Retention is Prometheus's own
 * (`--storage.tsdb.retention.time`, 15 days in docker-compose.prod.yml).
 */
import { Histogram } from 'prom-client';
import { METRICS_REGISTRY } from './learning-metrics.service';
import type { RumMetric, VitalSample } from '../rum/web-vitals.util';

function histogram(name: string, help: string, buckets: number[]): Histogram {
  return (
    (METRICS_REGISTRY.getSingleMetric(name) as Histogram | undefined) ??
    new Histogram({
      name,
      help,
      labelNames: ['route', 'device'],
      buckets,
      registers: [METRICS_REGISTRY],
    })
  );
}

const HISTOGRAMS: Record<RumMetric, { readonly metric: Histogram; readonly scale: number }> = {
  LCP: {
    metric: histogram(
      'atlas_rum_lcp_seconds',
      'Largest Contentful Paint reported by sampled real visits.',
      [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 20],
    ),
    scale: 1 / 1000,
  },
  INP: {
    metric: histogram(
      'atlas_rum_inp_seconds',
      'Interaction to Next Paint reported by sampled real visits.',
      [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1, 2],
    ),
    scale: 1 / 1000,
  },
  CLS: {
    metric: histogram(
      'atlas_rum_cls',
      'Cumulative Layout Shift reported by sampled real visits.',
      [0.01, 0.05, 0.1, 0.15, 0.25, 0.4, 0.6, 1],
    ),
    scale: 1,
  },
};

/** Metric names the aggregated view queries. */
export const RUM_HISTOGRAM_NAMES: Record<RumMetric, string> = {
  LCP: 'atlas_rum_lcp_seconds',
  INP: 'atlas_rum_inp_seconds',
  CLS: 'atlas_rum_cls',
};
/** Multiply a Prometheus value by this to get the metric's own unit (ms for LCP/INP). */
export const RUM_DISPLAY_SCALE: Record<RumMetric, number> = { LCP: 1000, INP: 1000, CLS: 1 };

export function recordVital(sample: VitalSample): void {
  const { metric, scale } = HISTOGRAMS[sample.metric];
  metric.observe({ route: sample.route, device: sample.device }, sample.value * scale);
}
