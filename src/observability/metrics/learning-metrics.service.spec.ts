/**
 * P64 Phase 4 (§D.5 / §U) — the metrics service's own contract.
 *
 * Two properties matter and both are asserted against the REAL registry
 * output (`render()`, the exact bytes a scraper receives), never against
 * a mock of prom-client:
 *
 *   1. every `record*` method lands on the series and labels §D.5 names,
 *      with the value it was given;
 *   2. nothing in this service can throw into the request it describes —
 *      `safely()` swallows prom-client's own validation errors (a NaN
 *      observation, a negative counter increment) and leaves the series
 *      untouched.
 *
 * The registry is module-scoped, so counters accumulate across the cases
 * in this file; every assertion therefore reads a series/label pair that
 * no other case in the file touches, or compares before/after.
 */
import { Logger } from '@nestjs/common';
import { LearningMetricsService } from './learning-metrics.service';

/** The rendered sample line for `name{labels...}` — `null` when the series has no such sample yet. */
function sample(
  body: string,
  name: string,
  labels: Record<string, string>,
): number | null {
  const pairs = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  const line = body.split('\n').find((candidate) => {
    if (!candidate.startsWith(`${name}{`)) return false;
    const labelBlock = candidate.slice(name.length + 1, candidate.indexOf('}'));
    return pairs.every((pair) => labelBlock.split(',').includes(pair));
  });
  if (!line) return null;
  return Number(line.slice(line.lastIndexOf(' ') + 1));
}

function scalar(body: string, name: string): number | null {
  const line = body.split('\n').find((candidate) => candidate.startsWith(`${name} `));
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : null;
}

describe('LearningMetricsService — P64 Phase 4 series', () => {
  let service: LearningMetricsService;
  let warn: jest.SpyInstance;

  beforeAll(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    service = new LearningMetricsService();
  });

  afterAll(() => {
    warn.mockRestore();
  });

  it('registers every Phase 4 series so a scrape sees the names before any event', async () => {
    const { body, contentType } = await service.render();
    expect(contentType).toContain('text/plain');
    for (const name of [
      'atlas_checkout_orders_total',
      'atlas_checkout_approval_latency_seconds',
      'atlas_public_catalog_query_duration_ms',
      'atlas_retention_sweep_pruned_rows_total',
      'atlas_retention_sweep_runs_total',
    ]) {
      expect(body).toContain(`# HELP ${name} `);
      expect(body).toContain(`# TYPE ${name} `);
    }
    expect(body).toContain('# TYPE atlas_checkout_orders_total counter');
    expect(body).toContain('# TYPE atlas_checkout_approval_latency_seconds histogram');
    expect(body).toContain('# TYPE atlas_public_catalog_query_duration_ms histogram');
    expect(body).toContain('# TYPE atlas_retention_sweep_pruned_rows_total counter');
    expect(body).toContain('# TYPE atlas_retention_sweep_runs_total counter');
  });

  it('recordCheckoutOrderState increments the `state` label it was given and no other', async () => {
    service.recordCheckoutOrderState('paid');
    service.recordCheckoutOrderState('paid');
    service.recordCheckoutOrderState('refunded');
    const { body } = await service.render();
    expect(sample(body, 'atlas_checkout_orders_total', { state: 'paid' })).toBe(2);
    expect(sample(body, 'atlas_checkout_orders_total', { state: 'refunded' })).toBe(1);
    expect(
      sample(body, 'atlas_checkout_orders_total', { state: 'cancelled' }),
    ).toBeNull();
  });

  it('recordRetentionPruned adds the row count under the `table` label', async () => {
    service.recordRetentionPruned('quiz_attempt_events', 7);
    service.recordRetentionPruned('quiz_attempt_events', 0);
    service.recordRetentionPruned('content_access_log', 2);
    const { body } = await service.render();
    expect(
      sample(body, 'atlas_retention_sweep_pruned_rows_total', {
        table: 'quiz_attempt_events',
      }),
    ).toBe(7);
    expect(
      sample(body, 'atlas_retention_sweep_pruned_rows_total', {
        table: 'content_access_log',
      }),
    ).toBe(2);
  });

  it('recordRetentionSweepRun maps ok/error onto the `result` label', async () => {
    service.recordRetentionSweepRun('content_access_log', true);
    service.recordRetentionSweepRun('content_access_log', false);
    service.recordRetentionSweepRun('content_access_log', false);
    const { body } = await service.render();
    expect(
      sample(body, 'atlas_retention_sweep_runs_total', {
        table: 'content_access_log',
        result: 'ok',
      }),
    ).toBe(1);
    expect(
      sample(body, 'atlas_retention_sweep_runs_total', {
        table: 'content_access_log',
        result: 'error',
      }),
    ).toBe(2);
  });

  it('recordCheckoutApprovalLatency observes seconds into the approval histogram', async () => {
    service.recordCheckoutApprovalLatency(1800);
    const { body } = await service.render();
    expect(scalar(body, 'atlas_checkout_approval_latency_seconds_count')).toBe(1);
    expect(scalar(body, 'atlas_checkout_approval_latency_seconds_sum')).toBe(1800);
    expect(
      sample(body, 'atlas_checkout_approval_latency_seconds_bucket', { le: '900' }),
    ).toBe(0);
    expect(
      sample(body, 'atlas_checkout_approval_latency_seconds_bucket', { le: '1800' }),
    ).toBe(1);
  });

  it('recordPublicCatalogQuery observes milliseconds into the catalog histogram', async () => {
    service.recordPublicCatalogQuery(12);
    const { body } = await service.render();
    expect(scalar(body, 'atlas_public_catalog_query_duration_ms_count')).toBe(1);
    expect(scalar(body, 'atlas_public_catalog_query_duration_ms_sum')).toBe(12);
    expect(
      sample(body, 'atlas_public_catalog_query_duration_ms_bucket', { le: '10' }),
    ).toBe(0);
    expect(
      sample(body, 'atlas_public_catalog_query_duration_ms_bucket', { le: '25' }),
    ).toBe(1);
  });

  it('never throws: an invalid observation is swallowed, logged, and leaves the series unchanged', async () => {
    const before = await service.render();
    const countBefore = scalar(
      before.body,
      'atlas_checkout_approval_latency_seconds_count',
    );
    const catalogBefore = scalar(
      before.body,
      'atlas_public_catalog_query_duration_ms_count',
    );
    warn.mockClear();

    // prom-client rejects both of these itself (`Value is not a valid
    // number`, `It is not possible to decrease a counter`); the request
    // must not learn that.
    expect(() => service.recordCheckoutApprovalLatency(Number.NaN)).not.toThrow();
    expect(() => service.recordPublicCatalogQuery(Number.NaN)).not.toThrow();
    expect(() => service.recordRetentionPruned('quiz_attempt_events', -1)).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(3);
    const after = await service.render();
    expect(scalar(after.body, 'atlas_checkout_approval_latency_seconds_count')).toBe(
      countBefore,
    );
    expect(scalar(after.body, 'atlas_public_catalog_query_duration_ms_count')).toBe(
      catalogBefore,
    );
    expect(
      sample(after.body, 'atlas_retention_sweep_pruned_rows_total', {
        table: 'quiz_attempt_events',
      }),
    ).toBe(7);
  });

  it('a second instance shares the process registry instead of re-registering', async () => {
    // Every e2e spec boots a second Nest application in the same process;
    // prom-client throws on a duplicate registration, so the factories
    // must hand back the existing series.
    expect(() => new LearningMetricsService()).not.toThrow();
    const other = new LearningMetricsService();
    other.recordCheckoutOrderState('expired');
    const { body } = await service.render();
    expect(sample(body, 'atlas_checkout_orders_total', { state: 'expired' })).toBe(1);
  });
});
