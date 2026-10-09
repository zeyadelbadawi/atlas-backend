/**
 * W3 — JSON body limits are per route (`common/http/body-limits.ts`).
 *
 * A global 30 MB JSON parser used to run before every guard and the
 * throttler, so an anonymous caller could make the API buffer and parse
 * 30 MB on any route. Pinned here against the real application:
 *   - an ordinary/public route refuses a body over 100 KB with 413;
 *   - the base64 upload bridge still accepts a real, large upload.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

/** A real 1x1 PNG; trailing bytes after IEND keep it a valid PNG by magic bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('W3 — per-route JSON body limits (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    await testApp.flushRateLimitKeys();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('refuses a body over 100 KB on unauthenticated routes before they run', async () => {
    const padding = 'a'.repeat(150 * 1024);
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: 'nobody@atlas.test', password: padding })
      .expect(413);
    await request(app.getHttpServer())
      .post('/public/contact')
      .send({ name: 'x', email: 'x@atlas.test', message: padding })
      .expect(413);
    // Under the limit the route answers on its own terms (validation /
    // credentials), not with 413.
    const small = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: 'nobody@atlas.test', password: 'a'.repeat(1024) });
    expect(small.status).not.toBe(413);
  });

  it('still accepts a multi-megabyte base64 upload on the media route', async () => {
    const email = uniqueTestEmail('w3-upload');
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'W3 Owner', email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    const org = await seedOrganizationWithOwner(admin, signIn.body.user.id, 'w3-org');
    await seedActiveSubscriptionForOrg(admin, org.id, 'w3');
    const academy = await seedAcademy(admin, org.id, 'w3-academy');
    await seedAcademyMember(admin, academy.id, signIn.body.user.id, 'owner');

    const bytes = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024, 7)]);
    const uploaded = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/media`)
      .set('Authorization', `Bearer ${signIn.body.accessToken as string}`)
      .send({
        fileName: 'big.png',
        mimeType: 'image/png',
        sizeBytes: bytes.length,
        dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
      })
      .expect(201);
    expect(uploaded.body.sizeBytes).toBe(bytes.length);
  });
});
