/**
 * Platform Owner Observability Center API (e2e, real Postgres + Redis).
 *
 * Prometheus and Alertmanager are stood in for by a local HTTP server whose
 * answers each test controls, so the API's honesty rules are pinned:
 * unreachable → `unavailable`, malformed → `unavailable` (never data),
 * valid → normalised. The real Prometheus/Alertmanager path is verified
 * separately end to end (see PLATFORM_OWNER_OBSERVABILITY_HANDOVER.md).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

type Handler = (path: string) => { status: number; body: unknown } | 'hang';
let handler: Handler = () => ({ status: 503, body: {} });

const now = () => Date.now() / 1000;

const RULES_BODY = {
  status: 'success',
  data: {
    groups: [
      {
        name: 'atlas-platform',
        rules: [
          {
            type: 'alerting',
            name: 'AtlasApiHighErrorRate',
            query: 'sum(rate(atlas_http_requests_total[5m])) > 0',
            duration: 300,
            labels: { severity: 'critical', service: 'api' },
            annotations: { summary: 'API 5xx', threshold: '5xx > 5%' },
            alerts: [],
            health: 'ok',
            state: 'inactive',
          },
        ],
      },
    ],
  },
};

describe('Platform Owner Observability Center API (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let stub: Server;
  let flush: () => Promise<void>;
  const previous = { p: process.env.PROMETHEUS_URL, a: process.env.ALERTMANAGER_URL };

  beforeAll(async () => {
    stub = createServer((req, res) => {
      const answer = handler(req.url ?? '');
      if (answer === 'hang') return; // timeout path
      res.writeHead(answer.status, { 'Content-Type': 'application/json' });
      res.end(
        typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
      );
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const { port } = stub.address() as AddressInfo;
    process.env.PROMETHEUS_URL = `http://127.0.0.1:${port}/prom`;
    process.env.ALERTMANAGER_URL = `http://127.0.0.1:${port}/am`;
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  beforeEach(async () => {
    await flush();
    handler = () => ({ status: 503, body: {} });
  });

  afterAll(async () => {
    process.env.PROMETHEUS_URL = previous.p;
    process.env.ALERTMANAGER_URL = previous.a;
    await admin.$disconnect();
    await app.close();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  });

  async function signIn(label: string) {
    const email = uniqueTestEmail(label);
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    return { userId: res.body.user.id as string, token: res.body.accessToken as string };
  }

  async function platformOwner(label: string) {
    const po = await signIn(label);
    await admin.user.update({
      where: { id: po.userId },
      data: { isPlatformOwner: true },
    });
    return po;
  }

  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(`/platform-observability/${path}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('is Platform Owner only: anonymous 401; client owner, manager, instructor, learner 403', async () => {
    const owner = await signIn('obs-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'obs-org');
    const academy = await seedAcademy(admin, org.id, 'obs-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const manager = await signIn('obs-manager');
    await seedMembership(admin, org.id, manager.userId, 'manager');
    const instructor = await signIn('obs-instructor');
    await seedMembership(admin, org.id, instructor.userId, 'instructor');
    const learner = await signIn('obs-learner');
    await seedAcademyStudent(admin, academy.id, learner.userId);

    for (const path of [
      'health',
      'alerts',
      'metrics',
      'configuration',
      'metrics/api.requestRate',
    ]) {
      await get(path).expect(401);
      for (const caller of [owner, manager, instructor, learner]) {
        await get(path, caller.token).expect(403);
      }
    }
    await request(app.getHttpServer())
      .post('/platform-observability/synthetic-alert')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ minutes: 5 })
      .expect(403);
  });

  it('health is honest when Prometheus and Alertmanager are unreachable', async () => {
    const po = await platformOwner('obs-po-health');
    const res = await get('health', po.token).expect(200);
    const byKey = Object.fromEntries(
      (res.body.components as { key: string; status: string }[]).map((c) => [c.key, c]),
    );
    expect(byKey.database.status).toBe('healthy');
    expect(byKey.redis.status).toBe('healthy');
    expect(byKey.prometheus.status).toBe('down');
    expect(byKey.alertmanager.status).toBe('down');
    // No Prometheus window → the API's health is unknown, never "healthy".
    expect(byKey.api.status).toBe('unknown');
    expect(res.body.alerts.source).toBe('unavailable');
    expect(res.body.alerts.active).toBe(0);
  });

  it('treats a malformed or timed-out source as unavailable, never as data', async () => {
    const po = await platformOwner('obs-po-malformed');
    handler = (path) =>
      path.startsWith('/prom')
        ? {
            status: 200,
            body: '{"status":"success","data":{"resultType":"vector","result":[{"bogus":1}]}}',
          }
        : 'hang';
    const catalog = await get('metrics', po.token).expect(200);
    expect(catalog.body.source).toBe('unavailable');
    expect(
      (catalog.body.metrics as { available: boolean }[]).every(
        (m) => m.available === false,
      ),
    ).toBe(true);
    const alerts = await get('alerts', po.token).expect(200);
    expect(alerts.body.sources.alertmanager).toBe('unavailable');
    expect(alerts.body.items).toEqual([]);
  });

  it('normalises real-shaped Prometheus/Alertmanager data: active, resolved history, rule detail', async () => {
    const po = await platformOwner('obs-po-data');
    const t = Math.floor(now());
    handler = (path) => {
      if (path.startsWith('/am/api/v2/alerts')) {
        return {
          status: 200,
          body: [
            {
              labels: {
                alertname: 'AtlasApiHighErrorRate',
                severity: 'critical',
                service: 'api',
              },
              annotations: { summary: 'API 5xx', description: '7.8% 5xx' },
              startsAt: new Date((t - 600) * 1000).toISOString(),
              fingerprint: 'abc',
              status: { state: 'active' },
            },
          ],
        };
      }
      if (path.startsWith('/prom/api/v1/rules')) return { status: 200, body: RULES_BODY };
      if (path.startsWith('/prom/api/v1/query_range')) {
        return {
          status: 200,
          body: {
            status: 'success',
            data: {
              resultType: 'matrix',
              result: [
                {
                  // A past incident, long resolved.
                  metric: {
                    __name__: 'ALERTS',
                    alertname: 'AtlasApiHighErrorRate',
                    alertstate: 'firing',
                    severity: 'critical',
                    service: 'api',
                  },
                  values: [
                    [t - 7200, '1'],
                    [t - 7200 + 300, '1'],
                    [t - 7200 + 600, '1'],
                  ],
                },
              ],
            },
          },
        };
      }
      if (path.startsWith('/prom/api/v1/query')) {
        return {
          status: 200,
          body: {
            status: 'success',
            data: { resultType: 'vector', result: [{ metric: {}, value: [t, '0.078'] }] },
          },
        };
      }
      return { status: 404, body: {} };
    };

    const list = await get('alerts?range=24h', po.token).expect(200);
    const statuses = (list.body.items as { status: string; rule: string }[]).map(
      (i) => i.status,
    );
    expect(statuses).toEqual(expect.arrayContaining(['firing', 'resolved']));
    const active = await get('alerts?status=active', po.token).expect(200);
    expect(active.body.items).toHaveLength(1);
    expect(active.body.items[0]).toMatchObject({
      rule: 'AtlasApiHighErrorRate',
      severity: 'critical',
      service: 'api',
      endsAt: null,
      affectedTenants: [],
    });

    const detail = await get('alerts/rules/AtlasApiHighErrorRate', po.token).expect(200);
    expect(detail.body.rule).toMatchObject({
      threshold: '5xx > 5%',
      editable: false,
      forSeconds: 300,
    });
    expect(detail.body.currentValues[0].value).toBeCloseTo(0.078);
    expect(detail.body.timeline.map((e: { kind: string }) => e.kind)).toEqual(
      expect.arrayContaining(['triggered', 'resolved']),
    );

    await get('alerts/rules/NoSuchRule', po.token).expect(404);
    await get('alerts/rules/bad%20rule%7B', po.token).expect(400);
    await get('metrics/not.aMetric', po.token).expect(404);
    await get('alerts?rule=x%22%7D%20or%20vector(1)', po.token).expect(400);
  });

  it('never exposes a Slack webhook URL; reports only whether a receiver exists', async () => {
    const po = await platformOwner('obs-po-config');
    handler = (path) => {
      if (path.startsWith('/am/api/v2/status')) {
        return {
          status: 200,
          body: {
            config: {
              original:
                'receivers:\n- name: atlas-slack\n  slack_configs:\n  - api_url_file: /etc/alertmanager/secrets/slack_webhook_url\n',
            },
          },
        };
      }
      if (path.startsWith('/prom/api/v1/rules')) return { status: 200, body: RULES_BODY };
      if (path.startsWith('/prom/api/v1/query')) {
        return {
          status: 200,
          body: { status: 'success', data: { resultType: 'vector', result: [] } },
        };
      }
      return { status: 404, body: {} };
    };
    const res = await get('configuration', po.token).expect(200);
    expect(res.body.channels[0]).toMatchObject({ kind: 'slack', configured: true });
    expect(JSON.stringify(res.body)).not.toMatch(/hooks\.slack\.com|api_url|secret/i);
    expect(res.body.rules[0]).toMatchObject({
      name: 'AtlasApiHighErrorRate',
      editable: false,
    });
  });

  it('arms and resolves the synthetic alert, exposes it on /metrics, and audits both', async () => {
    const po = await platformOwner('obs-po-synthetic');
    await request(app.getHttpServer())
      .post('/platform-observability/synthetic-alert')
      .set('Authorization', `Bearer ${po.token}`)
      .send({ minutes: 1 })
      .expect(400);
    const armed = await request(app.getHttpServer())
      .post('/platform-observability/synthetic-alert')
      .set('Authorization', `Bearer ${po.token}`)
      .send({ minutes: 5 })
      .expect(200);
    expect(armed.body.armed).toBe(true);

    const scrape = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${po.token}`)
      .expect(200);
    expect(scrape.text).toMatch(/atlas_synthetic_alert_armed 1/);
    expect(scrape.text).toMatch(/atlas_dependency_up\{dependency="database"\} 1/);
    expect(scrape.text).toMatch(
      /atlas_queue_jobs\{queue="communications",state="waiting"\}/,
    );
    expect(scrape.text).toMatch(/atlas_http_requests_total\{/);

    const resolved = await request(app.getHttpServer())
      .delete('/platform-observability/synthetic-alert')
      .set('Authorization', `Bearer ${po.token}`)
      .expect(200);
    expect(resolved.body.armed).toBe(false);
    const after = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${po.token}`)
      .expect(200);
    expect(after.text).toMatch(/atlas_synthetic_alert_armed 0/);

    const audits = await admin.auditLogEntry.findMany({
      where: { actorUserId: po.userId, targetType: 'observability' },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual([
      'observability.synthetic_alert.armed',
      'observability.synthetic_alert.resolved',
    ]);
  });
});
