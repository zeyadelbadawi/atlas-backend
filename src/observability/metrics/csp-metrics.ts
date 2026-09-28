/**
 * Authentication audit, Decision 4 — Content-Security-Policy violations
 * reported by browsers. Registered on `METRICS_REGISTRY` like the other
 * signal modules. Labels are closed vocabularies (the directive name is
 * validated to `[a-z-]` by the parser; the blocked kind is an enum) — never
 * a URL, host or user value, so a hostile reporter cannot grow the series.
 */
import { Counter } from 'prom-client';
import { METRICS_REGISTRY } from './learning-metrics.service';
import type { CspViolation } from '../../security-reports/csp-report.util';

const KNOWN_DIRECTIVES = new Set([
  'default-src',
  'script-src',
  'script-src-elem',
  'script-src-attr',
  'style-src',
  'style-src-elem',
  'style-src-attr',
  'img-src',
  'font-src',
  'connect-src',
  'media-src',
  'frame-src',
  'child-src',
  'worker-src',
  'manifest-src',
  'object-src',
  'base-uri',
  'form-action',
  'frame-ancestors',
]);

const violations =
  (METRICS_REGISTRY.getSingleMetric('atlas_csp_violations_total') as
    Counter | undefined) ??
  new Counter({
    name: 'atlas_csp_violations_total',
    help: 'Content-Security-Policy violations reported by browsers (Report-Only while the policy is being assessed).',
    labelNames: ['directive', 'blocked', 'disposition'],
    registers: [METRICS_REGISTRY],
  });

export function recordCspViolation(violation: CspViolation): void {
  violations.inc({
    directive: KNOWN_DIRECTIVES.has(violation.directive) ? violation.directive : 'other',
    blocked: violation.blockedKind,
    disposition: violation.disposition,
  });
}
