/**
 * End-to-end health check.
 *
 * Requires a real PostgreSQL and Redis connection (`docker compose up -d`
 * plus a `.env` pointing at them) — this is deliberate: the point of this
 * test is proving the app can actually reach its real dependencies, not a
 * mocked stand-in for that fact. If infrastructure is unavailable, this
 * test fails/cannot run — it must never be made to pass by faking the
 * connections it exists to verify.
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns 200 with both dependencies reported up', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.details.database.status).toBe('up');
    expect(response.body.details.redis.status).toBe('up');
  });

  it('GET /health includes an x-request-id response header', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});
