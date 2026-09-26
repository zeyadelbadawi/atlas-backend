/**
 * `/metrics` authentication with the dedicated scrape credential (alert
 * routing). The token here is a throwaway test value, never a real secret.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const SCRAPE_TOKEN = 'test-only-scrape-token-0123456789abcdefghijklmnop';

describe('/metrics — scrape credential and platform-owner access (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  const previous = process.env.METRICS_SCRAPE_TOKEN;

  beforeAll(async () => {
    process.env.METRICS_SCRAPE_TOKEN = SCRAPE_TOKEN;
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.METRICS_SCRAPE_TOKEN;
    else process.env.METRICS_SCRAPE_TOKEN = previous;
    await admin.$disconnect();
    await app.close();
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

  it('refuses anonymous and wrong-credential scrapes', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(401);
    await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${SCRAPE_TOKEN}x`)
      .expect(401);
  });

  it('accepts the scrape credential and serves Prometheus text', async () => {
    const res = await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${SCRAPE_TOKEN}`)
      .expect(200);
    expect(res.text).toMatch(/# HELP /);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('keeps the platform-owner door and refuses other principals', async () => {
    const other = await signIn('metrics-other');
    await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${other.token}`)
      .expect(403);
    const owner = await signIn('metrics-owner');
    await admin.user.update({
      where: { id: owner.userId },
      data: { isPlatformOwner: true },
    });
    await request(app.getHttpServer())
      .get('/metrics')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
  });
});
