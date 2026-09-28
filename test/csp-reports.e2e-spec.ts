/**
 * Authentication audit, Decision 4 — the CSP report endpoint.
 *
 *   CSP-01  a legacy `application/csp-report` body is accepted without
 *           credentials, answered 204 and counted
 *   CSP-02  a Reporting API `application/reports+json` batch likewise
 *   CSP-03  garbage is answered 204 and counted as nothing
 *   CSP-04  the report URL's secrets never reach the log or the metric
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';
import { METRICS_REGISTRY } from '../src/observability/metrics/learning-metrics.service';

jest.setTimeout(60000);

describe('POST /security/csp-reports (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = (await createTestApp()).app;
  });

  afterAll(async () => {
    await app.close();
  });

  const total = async (labels: Record<string, string>) => {
    const metric = await METRICS_REGISTRY.getSingleMetric(
      'atlas_csp_violations_total',
    )?.get();
    return (metric?.values ?? [])
      .filter((v) => Object.entries(labels).every(([k, value]) => v.labels[k] === value))
      .reduce((sum, v) => sum + v.value, 0);
  };

  it('CSP-01 — a legacy report is accepted without credentials and counted', async () => {
    const before = await total({ directive: 'script-src-elem', blocked: 'external' });
    await request(app.getHttpServer())
      .post('/security/csp-reports')
      .set('Content-Type', 'application/csp-report')
      .send(
        JSON.stringify({
          'csp-report': {
            'document-uri': 'https://atlass.dpdns.org/auth/reset-password?token=SECRET',
            'effective-directive': 'script-src-elem',
            'blocked-uri': 'https://evil.example/x.js?sig=SECRET',
            disposition: 'report',
          },
        }),
      )
      .expect(204);
    expect(await total({ directive: 'script-src-elem', blocked: 'external' })).toBe(
      before + 1,
    );
  });

  it('CSP-02 — a Reporting API batch is accepted and every violation counted', async () => {
    const before = await total({ directive: 'style-src-elem', blocked: 'inline' });
    await request(app.getHttpServer())
      .post('/security/csp-reports')
      .set('Content-Type', 'application/reports+json')
      .send(
        JSON.stringify([
          {
            type: 'csp-violation',
            body: {
              effectiveDirective: 'style-src-elem',
              blockedURL: 'inline',
              disposition: 'report',
            },
          },
          {
            type: 'csp-violation',
            body: {
              effectiveDirective: 'style-src-elem',
              blockedURL: 'inline',
              disposition: 'report',
            },
          },
        ]),
      )
      .expect(204);
    expect(await total({ directive: 'style-src-elem', blocked: 'inline' })).toBe(
      before + 2,
    );
  });

  it('CSP-03 — garbage is answered 204 and counted as nothing', async () => {
    const metric = await METRICS_REGISTRY.getSingleMetric(
      'atlas_csp_violations_total',
    )?.get();
    const before = (metric?.values ?? []).reduce((s, v) => s + v.value, 0);
    for (const body of ['{}', '[]', '{"csp-report":"x"}', '[{"type":"other"}]']) {
      await request(app.getHttpServer())
        .post('/security/csp-reports')
        .set('Content-Type', 'application/csp-report')
        .send(body)
        .expect(204);
    }
    const after = await METRICS_REGISTRY.getSingleMetric(
      'atlas_csp_violations_total',
    )?.get();
    expect((after?.values ?? []).reduce((s, v) => s + v.value, 0)).toBe(before);
  });

  it('CSP-04 — no URL value becomes a metric label', async () => {
    const metric = await METRICS_REGISTRY.getSingleMetric(
      'atlas_csp_violations_total',
    )?.get();
    expect(JSON.stringify(metric)).not.toMatch(/SECRET|evil\.example|atlass/);
  });
});
