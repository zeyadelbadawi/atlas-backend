/**
 * `ops/alerts/atlas-prometheus-rules.yml` must never drift from the series
 * the application actually emits. Every `atlas_*` name referenced by a rule
 * expression (with the Prometheus histogram suffixes `_bucket`/`_count`/
 * `_sum` stripped) must be registered in `LearningMetricsService`, and every
 * rule must carry the fields Alertmanager routing relies on. Text-level
 * checks on purpose — no YAML library dependency, and the file is small.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RULES_PATH = resolve(__dirname, '../../../ops/alerts/atlas-prometheus-rules.yml');
/**
 * Every file that registers an `atlas_*` series into the shared registry.
 * Missing one is worse than it looks: this spec would then flag a VALID
 * rule as referencing an unknown series, and — the dangerous direction —
 * would never notice a rule pointing at a series that does not exist,
 * which is an alert that can never fire.
 *
 * There are two communications metrics files because the outbox and the
 * provider layer were built in parallel and each added one. They own
 * different series (dispatch/outbox/OTP vs provider/quota/webhook) and
 * both are live, but they share the class name `CommunicationMetricsService`,
 * which is a footgun worth consolidating when nothing else is in flight.
 */
const SERVICE_PATHS = [
  resolve(__dirname, 'learning-metrics.service.ts'),
  resolve(__dirname, '../../communications/services/communication-metrics.service.ts'),
  resolve(__dirname, '../../communications/metrics/communication-metrics.service.ts'),
];

const rules = readFileSync(RULES_PATH, 'utf8');
const service = SERVICE_PATHS.map((path) => readFileSync(path, 'utf8')).join('\n');

const emittedSeries = new Set(
  [...service.matchAll(/'(atlas_[a-z0-9_]+)'/g)].map((m) => m[1]),
);

function referencedSeries(text: string): string[] {
  return [...new Set([...text.matchAll(/\b(atlas_[a-z0-9_]+)/g)].map((m) => m[1]))].map(
    (name) => name.replace(/_(bucket|count|sum)$/, ''),
  );
}

/** Splits the file into one string per `- alert:` block. */
function ruleBlocks(text: string): string[] {
  return text.split(/\n\s*- alert: /).slice(1);
}

describe('alert rules stay in sync with the metrics services', () => {
  it('registers at least the Phase 4 series in the service (guard against a stale regex)', () => {
    for (const name of [
      'atlas_checkout_orders_total',
      'atlas_checkout_approval_latency_seconds',
      'atlas_public_catalog_query_duration_ms',
      'atlas_retention_sweep_runs_total',
      'atlas_content_grants_total',
      'atlas_comm_quota_used_ratio',
      'atlas_comm_email_sends_total',
    ]) {
      expect(emittedSeries.has(name)).toBe(true);
    }
  });

  it('every series a rule references is emitted by the application', () => {
    const unknown = referencedSeries(rules).filter((name) => !emittedSeries.has(name));
    expect(unknown).toEqual([]);
  });

  it('every rule has an expr, a severity label, a team label and a summary', () => {
    const blocks = ruleBlocks(rules);
    expect(blocks.length).toBeGreaterThanOrEqual(8);
    for (const block of blocks) {
      const name = block.split('\n')[0]?.trim();
      expect(block).toMatch(/\n\s*expr:/);
      expect(block).toMatch(/severity:\s*(critical|warning|info)/);
      expect(block).toMatch(/team:\s*atlas/);
      expect(block).toMatch(/summary:/);
      expect(name).toMatch(/^Atlas[A-Za-z]+$/);
    }
  });

  it('covers the retention sweep both failing and going silent (the defect Phase 4 fixed)', () => {
    expect(rules).toContain('AtlasRetentionSweepFailing');
    expect(rules).toContain('AtlasRetentionSweepSilent');
    expect(rules).toMatch(/atlas_retention_sweep_runs_total\{result="error"\}/);
  });

  it('covers the P64 Communications quota, bounce-rate and webhook-verification alerts', () => {
    for (const name of [
      'AtlasEmailQuotaHigh',
      'AtlasEmailQuotaCritical',
      'AtlasEmailBounceRate',
      'AtlasEmailWebhookSignatureFailures',
    ]) {
      expect(rules).toContain(name);
    }
    expect(rules).toMatch(/atlas_comm_quota_used_ratio\) by \(provider, window\) > 0\.8/);
    expect(rules).toMatch(
      /atlas_comm_quota_used_ratio\) by \(provider, window\) > 0\.95/,
    );
  });
});
