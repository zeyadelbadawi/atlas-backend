/**
 * Real-user monitoring (P6) — the aggregated view for the Platform Owner.
 *
 * p75 per metric × route template × device class over a window, straight
 * from the self-hosted Prometheus (`histogram_quantile` over the RUM
 * histograms), with the sample count behind each figure and the rating
 * against the published thresholds. Rows with too few samples to mean
 * anything are marked as such rather than hidden or rated.
 */
import { Injectable } from '@nestjs/common';
import { MonitoringSourcesClient } from './monitoring-sources.client';
import {
  RUM_DEVICES,
  RUM_METRICS,
  RUM_ROUTES,
  rateVital,
  type RumDevice,
  type RumMetric,
  type RumRoute,
} from '../rum/web-vitals.util';
import { RUM_DISPLAY_SCALE, RUM_HISTOGRAM_NAMES } from '../metrics/rum-metrics';

/** Below this many samples a p75 is shown but not rated. */
export const RUM_MIN_SAMPLES_FOR_RATING = 20;

export type WebVitalsRange = '24h' | '7d';

export interface WebVitalsRow {
  readonly metric: RumMetric;
  readonly route: RumRoute;
  readonly device: RumDevice;
  /** In the metric's own unit: ms for LCP/INP, unitless for CLS. */
  readonly p75: number;
  readonly samples: number;
  readonly rating: 'good' | 'needs-improvement' | 'poor' | 'too-few-samples';
}

export interface WebVitalsResponse {
  readonly state: 'ok' | 'unavailable' | 'not_configured';
  readonly range: WebVitalsRange;
  readonly rows: readonly WebVitalsRow[];
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

@Injectable()
export class WebVitalsService {
  constructor(private readonly sources: MonitoringSourcesClient) {}

  async aggregate(range: WebVitalsRange): Promise<WebVitalsResponse> {
    const rows: WebVitalsRow[] = [];
    for (const metric of RUM_METRICS) {
      const name = RUM_HISTOGRAM_NAMES[metric];
      const [quantiles, counts] = await Promise.all([
        this.sources.instant(
          `histogram_quantile(0.75, sum by (le, route, device) (increase(${name}_bucket[${range}])))`,
        ),
        this.sources.instant(`sum by (route, device) (increase(${name}_count[${range}]))`),
      ]);
      if (quantiles.state !== 'ok') return { state: quantiles.state, range, rows: [] };
      if (counts.state !== 'ok') return { state: counts.state, range, rows: [] };
      const countOf = new Map(
        counts.data.map((s) => [`${s.metric.route}|${s.metric.device}`, Number(s.value[1])]),
      );
      for (const series of quantiles.data) {
        const { route, device } = series.metric;
        if (!isOneOf(RUM_ROUTES, route) || !isOneOf(RUM_DEVICES, device)) continue;
        const raw = Number(series.value[1]);
        const samples = Math.round(countOf.get(`${route}|${device}`) ?? 0);
        if (!Number.isFinite(raw) || samples === 0) continue;
        const p75 = raw * RUM_DISPLAY_SCALE[metric];
        rows.push({
          metric,
          route,
          device,
          p75: metric === 'CLS' ? Math.round(p75 * 1000) / 1000 : Math.round(p75),
          samples,
          rating: samples < RUM_MIN_SAMPLES_FOR_RATING ? 'too-few-samples' : rateVital(metric, p75),
        });
      }
    }
    rows.sort((a, b) =>
      a.route === b.route
        ? a.device === b.device
          ? RUM_METRICS.indexOf(a.metric) - RUM_METRICS.indexOf(b.metric)
          : a.device.localeCompare(b.device)
        : RUM_ROUTES.indexOf(a.route) - RUM_ROUTES.indexOf(b.route),
    );
    return { state: 'ok', range, rows };
  }
}
