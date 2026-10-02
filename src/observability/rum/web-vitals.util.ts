/**
 * Real-user monitoring (P6) — what a browser may report, and nothing else.
 *
 * The beacon is unauthenticated and therefore hostile input. Only three
 * metrics, a closed list of route TEMPLATES (never a URL, id or query) and
 * two device classes are accepted; values outside a plausible range are
 * dropped. Every label is a closed vocabulary, so a hostile reporter can
 * skew numbers but cannot grow the metric series or carry personal data —
 * there is no field in which personal data could travel.
 */
export const RUM_METRICS = ['LCP', 'INP', 'CLS'] as const;
export type RumMetric = (typeof RUM_METRICS)[number];

/** Route templates the frontend classifies pages into (`route-template.ts` there). */
export const RUM_ROUTES = [
  'public:home',
  'public:courses',
  'public:course',
  'public:page',
  'public:auth',
  'public:learn',
  'app:dashboard',
  'app:learn',
  'app:builder',
  'app:instructor',
  'app:platform',
  'app:auth',
  'app:other',
] as const;
export type RumRoute = (typeof RUM_ROUTES)[number];

export const RUM_DEVICES = ['mobile', 'desktop'] as const;
export type RumDevice = (typeof RUM_DEVICES)[number];

/** A beacon carries at most this many samples (one visit reports three metrics). */
export const MAX_SAMPLES_PER_BEACON = 3;

/** Values above these are not real measurements of a page (ms for LCP/INP; CLS is unitless). */
const MAX_VALUE: Record<RumMetric, number> = { LCP: 60_000, INP: 60_000, CLS: 10 };

/** The published "good" / "poor" thresholds (web.dev/vitals). */
export const RUM_THRESHOLDS: Record<RumMetric, { good: number; poor: number }> = {
  LCP: { good: 2500, poor: 4000 },
  INP: { good: 200, poor: 500 },
  CLS: { good: 0.1, poor: 0.25 },
};

export interface VitalSample {
  readonly metric: RumMetric;
  readonly value: number;
  readonly route: RumRoute;
  readonly device: RumDevice;
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** The valid samples in a beacon body; anything malformed is dropped silently. */
export function parseVitalsBeacon(body: unknown): VitalSample[] {
  const samples = (body as { samples?: unknown } | null)?.samples;
  if (!Array.isArray(samples)) return [];
  const result: VitalSample[] = [];
  const seen = new Set<RumMetric>();
  for (const raw of samples.slice(0, MAX_SAMPLES_PER_BEACON)) {
    const sample = raw as Record<string, unknown> | null;
    if (!sample || typeof sample !== 'object') continue;
    const { metric, value, route, device } = sample;
    if (!isOneOf(RUM_METRICS, metric) || seen.has(metric)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (value < 0 || value > MAX_VALUE[metric]) continue;
    if (!isOneOf(RUM_DEVICES, device)) continue;
    seen.add(metric);
    result.push({
      metric,
      value,
      route: isOneOf(RUM_ROUTES, route) ? route : 'app:other',
      device,
    });
  }
  return result;
}

export function rateVital(
  metric: RumMetric,
  value: number,
): 'good' | 'needs-improvement' | 'poor' {
  const { good, poor } = RUM_THRESHOLDS[metric];
  if (value <= good) return 'good';
  if (value <= poor) return 'needs-improvement';
  return 'poor';
}
