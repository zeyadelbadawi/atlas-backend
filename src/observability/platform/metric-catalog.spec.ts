/**
 * The Observability Center's metric catalog can only name series Atlas (or
 * the node/Prometheus/Alertmanager runtimes) really emits — a catalog entry
 * for a series nobody registers would be a chart of nothing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { METRIC_CATALOG } from './metric-catalog';

const SOURCES = [
  '../metrics/learning-metrics.service.ts',
  '../../communications/services/communication-metrics.service.ts',
  '../../communications/metrics/communication-metrics.service.ts',
  './http-metrics.middleware.ts',
  './system-probes.service.ts',
  './observability.service.ts',
]
  .map((path) => readFileSync(resolve(__dirname, path), 'utf8'))
  .join('\n');

const emitted = new Set([...SOURCES.matchAll(/'(atlas_[a-z0-9_]+)'/g)].map((m) => m[1]));

describe('observability metric catalog', () => {
  it('has unique ids', () => {
    const ids = METRIC_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(
    METRIC_CATALOG.filter((m) => m.requires.startsWith('atlas_')).map((m) => [m.id, m]),
  )('%s depends on a series Atlas registers', (_id, entry) => {
    expect(emitted).toContain(entry.requires.replace(/_(bucket|count|sum)$/, ''));
  });

  it('never lets a query reach Prometheus except through a catalog entry', () => {
    for (const entry of METRIC_CATALOG) expect(entry.expr).not.toMatch(/\$\{|\binput\b/);
  });
});
