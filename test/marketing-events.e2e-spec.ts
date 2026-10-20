/**
 * B1 F.5 — `POST /mkt/events`, the marketing website's cookieless beacon,
 * against real Postgres + Redis.
 *
 *   MKT-01  a valid batch from a browser → 204, today's aggregate rows grow
 *   MKT-02  bots, GPC/DNT requests, unknown events and garbage → 204, nothing stored
 *   MKT-03  the response sets no cookie; malformed JSON → 400; over 16 KB → 413
 *   MKT-04  concurrent beacons converge on one row per day (ON CONFLICT)
 *   MKT-05  the retention prune deletes days older than 25 months only
 *   MKT-06  nothing but closed-vocabulary dimensions and a count is stored
 */
process.env.MARKETING_EVENTS_ENABLED = 'true';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { MarketingEventsService } from '../src/marketing-events/marketing-events.service';
import { utcDay } from '../src/marketing-events/marketing-events.util';

jest.setTimeout(60000);

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const dims = { page: 'mkt:security', locale: 'ar', device: 'desktop' } as const;

describe('POST /mkt/events (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    await flushRateLimitKeys();
  });

  afterAll(async () => {
    await flushRateLimitKeys();
    await admin.$disconnect();
    await app.close();
  });

  const countOf = async (name: string, value = ''): Promise<number> => {
    const rows = await admin.marketingEventDaily.findMany({
      where: { day: utcDay(new Date()), name, value, ...dims },
    });
    return rows.reduce((sum, row) => sum + row.count, 0);
  };

  const post = (
    body: unknown,
    headers: Record<string, string> = { 'User-Agent': CHROME },
  ) => {
    const req = request(app.getHttpServer())
      .post('/mkt/events')
      .set('Content-Type', 'application/json');
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return req.send(typeof body === 'string' ? body : JSON.stringify(body));
  };

  it('MKT-01 — a valid batch is answered 204 and added to today’s aggregates', async () => {
    const views = await countOf('page_viewed');
    const ctas = await countOf('cta_clicked', 'cta_t');
    await post({
      events: [
        { name: 'page_viewed', ...dims },
        { name: 'page_viewed', ...dims },
        { name: 'cta_clicked', ...dims, props: { value: 'cta_t' } },
        { name: 'cta_clicked', ...dims, props: { value: 'cta_t' } },
      ],
    }).expect(204);
    expect(await countOf('page_viewed')).toBe(views + 1);
    expect(await countOf('cta_clicked', 'cta_t')).toBe(ctas + 2);
  });

  it('MKT-02 — bots, opted-out requests, unknown events and garbage store nothing', async () => {
    const views = await countOf('page_viewed');
    const valid = { events: [{ name: 'page_viewed', ...dims }] };
    await post(valid, { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }).expect(
      204,
    );
    await post(valid, { 'User-Agent': 'curl/8.4.0' }).expect(204);
    await post(valid, { 'User-Agent': CHROME, 'Sec-GPC': '1' }).expect(204);
    await post(valid, { 'User-Agent': CHROME, DNT: '1' }).expect(204);
    await post({
      events: [{ name: 'page_viewed', ...dims, page: '/pricing?x=1' }],
    }).expect(204);
    await post({ samples: [] }).expect(204);
    await post([1, 2, 3]).expect(204);
    expect(await countOf('page_viewed')).toBe(views);
  });

  it('MKT-03 — no cookie is set; malformed JSON is 400; an oversized body is 413', async () => {
    const res = await post({ events: [{ name: 'page_viewed', ...dims }] }).expect(204);
    expect(res.headers['set-cookie']).toBeUndefined();
    await post('{"events": [').expect(400);
    await post({ events: [], pad: 'a'.repeat(17 * 1024) }).expect(413);
  });

  it('MKT-04 — concurrent beacons converge on one row per day', async () => {
    const before = await countOf('faq_expanded', '7');
    await Promise.all(
      Array.from({ length: 6 }, () =>
        post({
          events: [{ name: 'faq_expanded', ...dims, props: { value: '7' } }],
        }).expect(204),
      ),
    );
    const rows = await admin.marketingEventDaily.findMany({
      where: { day: utcDay(new Date()), name: 'faq_expanded', value: '7', ...dims },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(before + 6);
  });

  it('MKT-05 — the retention prune deletes days older than 25 months only', async () => {
    const old = new Date(Date.UTC(2020, 0, 1));
    const recent = utcDay(new Date(Date.now() - 400 * 24 * 60 * 60 * 1000));
    for (const day of [old, recent]) {
      await admin.marketingEventDaily.upsert({
        where: {
          dimensions: {
            day,
            name: 'page_viewed',
            ...dims,
            value: '',
            utmSource: '',
            utmMedium: '',
            utmCampaign: '',
            referrerDomain: '',
          },
        },
        create: { day, name: 'page_viewed', ...dims, count: 3 },
        update: { count: 3 },
      });
    }
    const result = await app.get(MarketingEventsService, { strict: false }).prune();
    expect(result.retentionMonths).toBe(25);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await admin.marketingEventDaily.count({ where: { day: old } })).toBe(0);
    expect(await admin.marketingEventDaily.count({ where: { day: recent } })).toBe(1);
    await admin.marketingEventDaily.deleteMany({ where: { day: recent, ...dims } });
  });

  it('MKT-06 — a campaign landing stores registered values and a bare hostname only', async () => {
    await post({
      events: [
        {
          name: 'campaign_landing',
          ...dims,
          props: {
            utm_source: 'Google',
            utm_medium: 'cpc',
            utm_campaign: 'ahmed@example.com',
            referrer_domain: 'https://evil.example/path?q=1',
          },
          url: 'https://atlas.test/?utm_source=google&email=a@b.c',
        },
      ],
    }).expect(204);
    const rows = await admin.marketingEventDaily.findMany({
      where: { day: utcDay(new Date()), name: 'campaign_landing', ...dims },
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(['google', 'unregistered', '']).toContain(row.utmSource);
      expect(['cpc', 'unregistered', '']).toContain(row.utmMedium);
      expect(['unregistered', '']).toContain(row.utmCampaign);
      expect(row.referrerDomain).toBe('');
      expect(JSON.stringify(row)).not.toMatch(/@|https?:|\?/);
    }
  });
});
