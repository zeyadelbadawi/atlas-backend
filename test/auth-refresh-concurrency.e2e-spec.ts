/**
 * Dedicated concurrency proof for refresh-token rotation (master plan §21
 * P1 requirement #9/"Refresh": "Add a dedicated concurrency test proving
 * the behavior... concurrent refresh requests using the same refresh token
 * must not both succeed"). Runs against real Postgres so the guarantee is
 * proven under Postgres's actual row-locking semantics, not an in-memory
 * mock that can't demonstrate the race at all.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';

describe('Refresh-token rotation concurrency (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
  });

  afterAll(async () => {
    await app.close();
  });

  it('exactly one of N concurrent refresh calls with the same token succeeds', async () => {
    const email = uniqueTestEmail('refresh-concurrency');
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Concurrency Fixture', email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    const refreshToken: string = signIn.body.refreshToken;

    const CONCURRENT_ATTEMPTS = 8;
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_ATTEMPTS }, () =>
        request(app.getHttpServer()).post('/auth/refresh').send({ refreshToken }),
      ),
    );

    const succeeded = responses.filter((r) => r.status === 200);
    const rejected = responses.filter((r) => r.status === 401);

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(CONCURRENT_ATTEMPTS - 1);

    // The database agrees: exactly one new, un-revoked row descends from
    // the original token, and the original itself is revoked exactly once.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(2); // the original (now revoked) + the one winner's new token.
    const revokedCount = rows.filter((r) => r.revokedAt !== null).length;
    expect(revokedCount).toBe(1);

    // The single winning new token is fully usable afterward.
    const winnersNewToken: string = succeeded[0].body.refreshToken;
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: winnersNewToken })
      .expect(200);
  });
});
