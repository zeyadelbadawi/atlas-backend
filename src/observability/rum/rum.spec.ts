/**
 * P6 — real-user monitoring: the beacon accepts only closed vocabularies
 * and plausible values, ingestion obeys RUM_ENABLED, and the aggregated
 * view reports p75 with its sample count, never rating a thin sample.
 */
import { METRICS_REGISTRY } from '../metrics/learning-metrics.service';
import { RumController } from './rum.controller';
import { MAX_SAMPLES_PER_BEACON, parseVitalsBeacon, rateVital } from './web-vitals.util';
import {
  WebVitalsService,
  RUM_MIN_SAMPLES_FOR_RATING,
} from '../platform/web-vitals.service';

const ok = { route: 'public:home', device: 'mobile' };

describe('parseVitalsBeacon', () => {
  it('keeps valid samples', () => {
    expect(
      parseVitalsBeacon({
        samples: [
          { metric: 'LCP', value: 1800, ...ok },
          { metric: 'CLS', value: 0.02, route: 'app:learn', device: 'desktop' },
        ],
      }),
    ).toEqual([
      { metric: 'LCP', value: 1800, ...ok },
      { metric: 'CLS', value: 0.02, route: 'app:learn', device: 'desktop' },
    ]);
  });

  it('never lets a URL, id or free text become a label: unknown routes collapse to app:other', () => {
    const [sample] = parseVitalsBeacon({
      samples: [
        {
          metric: 'INP',
          value: 120,
          route: '/my/courses/123?email=a@b.c',
          device: 'desktop',
        },
      ],
    });
    expect(sample.route).toBe('app:other');
  });

  it('drops unknown metrics/devices, non-finite, negative and implausible values, duplicates, and extra fields', () => {
    expect(
      parseVitalsBeacon({
        samples: [
          { metric: 'FID', value: 10, ...ok },
          { metric: 'LCP', value: 10, route: 'public:home', device: 'tv' },
          { metric: 'LCP', value: Number.NaN, ...ok },
          { metric: 'INP', value: -1, ...ok },
          { metric: 'CLS', value: 50, ...ok },
        ],
      }),
    ).toEqual([]);
    const parsed = parseVitalsBeacon({
      samples: [
        { metric: 'LCP', value: 900, ...ok, userId: 'u1', url: 'https://x' },
        { metric: 'LCP', value: 901, ...ok },
      ],
    });
    expect(parsed).toEqual([{ metric: 'LCP', value: 900, ...ok }]);
  });

  it(`reads at most ${MAX_SAMPLES_PER_BEACON} samples, and nothing from a malformed body`, () => {
    const many = ['LCP', 'INP', 'CLS', 'LCP'].map((metric) => ({
      metric,
      value: 1,
      ...ok,
    }));
    expect(parseVitalsBeacon({ samples: many })).toHaveLength(3);
    for (const body of [null, 'x', 42, {}, { samples: 'no' }])
      expect(parseVitalsBeacon(body)).toEqual([]);
  });

  it('rates against the published thresholds', () => {
    expect([
      rateVital('LCP', 2500),
      rateVital('LCP', 2501),
      rateVital('LCP', 4001),
    ]).toEqual(['good', 'needs-improvement', 'poor']);
    expect([rateVital('INP', 200), rateVital('CLS', 0.26)]).toEqual(['good', 'poor']);
  });
});

describe('RumController', () => {
  const lcpCount = async () => {
    const metric = await METRICS_REGISTRY.getSingleMetric('atlas_rum_lcp_seconds')!.get();
    return metric.values
      .filter(
        (v) =>
          (v as { metricName?: string }).metricName === 'atlas_rum_lcp_seconds_count' &&
          v.labels.route === 'public:course',
      )
      .reduce((sum, v) => sum + v.value, 0);
  };
  const controller = (enabled: string | undefined) =>
    new RumController({ get: () => enabled } as never);
  const beacon = {
    samples: [{ metric: 'LCP', value: 2100, route: 'public:course', device: 'desktop' }],
  };

  it('records nothing unless RUM_ENABLED is exactly "true"', async () => {
    const before = await lcpCount();
    controller(undefined).receive(beacon);
    controller('false').receive(beacon);
    controller('yes').receive(beacon);
    expect(await lcpCount()).toBe(before);
    controller('true').receive(beacon);
    expect(await lcpCount()).toBe(before + 1);
  });
});

describe('WebVitalsService.aggregate', () => {
  const vector = (rows: [Record<string, string>, number][]) => ({
    state: 'ok' as const,
    data: rows.map(([metric, value]) => ({
      metric,
      value: [0, String(value)] as [number, string],
    })),
  });

  it('p75 in the metric’s unit, with samples and rating; thin samples are not rated; foreign labels ignored', async () => {
    const instant = jest.fn(async (expr: string) => {
      const lcp = expr.includes('atlas_rum_lcp_seconds');
      if (expr.startsWith('histogram_quantile')) {
        return vector(
          lcp
            ? [
                [{ route: 'public:home', device: 'mobile' }, 3.1],
                [{ route: 'public:home', device: 'desktop' }, 1.2],
                [{ route: '/evil', device: 'mobile' }, 9],
              ]
            : [],
        );
      }
      return vector(
        lcp
          ? [
              [{ route: 'public:home', device: 'mobile' }, 240],
              [
                { route: 'public:home', device: 'desktop' },
                RUM_MIN_SAMPLES_FOR_RATING - 1,
              ],
            ]
          : [],
      );
    });
    const service = new WebVitalsService({ instant } as never);
    const result = await service.aggregate('7d');
    expect(result.state).toBe('ok');
    expect(result.rows).toEqual([
      {
        metric: 'LCP',
        route: 'public:home',
        device: 'desktop',
        p75: 1200,
        samples: 19,
        rating: 'too-few-samples',
      },
      {
        metric: 'LCP',
        route: 'public:home',
        device: 'mobile',
        p75: 3100,
        samples: 240,
        rating: 'needs-improvement',
      },
    ]);
    expect(instant.mock.calls[0][0]).toContain('[7d]');
  });

  it('Prometheus not configured / unavailable is reported as such, never as data', async () => {
    for (const state of ['not_configured', 'unavailable'] as const) {
      const service = new WebVitalsService({ instant: async () => ({ state }) } as never);
      expect(await service.aggregate('24h')).toEqual({ state, range: '24h', rows: [] });
    }
  });
});
