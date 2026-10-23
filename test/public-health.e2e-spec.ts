/**
 * B0-OPS-09 — the external uptime probe's target, `GET /api/v1/public/health`.
 *
 * Mounted with the same prefix and versioning as `main.ts`, so the path
 * asserted here is the one the probe calls through Caddy. Needs the real
 * PostgreSQL and Redis, like `health.e2e-spec.ts`: the point is that `ok`
 * means both answered.
 */
import { INestApplication, VersioningType } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

describe('Public health (e2e, B0-OPS-09)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health', 'metrics'] });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 200 {status:"ok"} without auth, a tenant host or cookies', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/public/health')
      .set('Host', 'atlass.dpdns.org')
      .expect(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('leaks nothing internal: no dependency names, versions, timings or errors', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/public/health');
    const raw = JSON.stringify(response.body);
    expect(Object.keys(response.body)).toEqual(['status']);
    expect(raw).not.toMatch(
      /database|redis|postgres|prisma|version|uptime|error|details|info/i,
    );
  });

  it('answers 503 {status:"unavailable"} when a dependency fails, still without details', async () => {
    const prisma = app.get(PrismaService);
    const spy = jest
      .spyOn(prisma, 'isHealthy')
      .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    // Past the 5 s answer cache.
    const realNow = Date.now;
    Date.now = () => realNow() + 10_000;
    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/public/health')
        .expect(503);
      expect(response.body).toEqual({ status: 'unavailable' });
      expect(JSON.stringify(response.body)).not.toContain('ECONNREFUSED');
    } finally {
      Date.now = realNow;
      spy.mockRestore();
    }
  });

  it('is not mounted unversioned or without the /api prefix', async () => {
    await request(app.getHttpServer()).get('/public/health').expect(404);
  });
});
