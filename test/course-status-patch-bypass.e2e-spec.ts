/**
 * A course's lifecycle moves only through its dedicated endpoints (real
 * Postgres, RLS enforced).
 *
 * `PATCH /academies/:id/courses/:courseId` used to accept `status`, so a
 * plain field edit could publish or archive a course past the publish
 * workflow (`CoursesService.setPublicationState`: its readiness hook and
 * its `course.published` audit row) and past the archive path — the bypass
 * `course-readiness.ts` flagged. `UpdateCourseDto` no longer has the field;
 * with the global `forbidNonWhitelisted` pipe a `status` key is a 400, never
 * a silent no-op. `publish`/`unpublish`/`DELETE` are unchanged.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedOrganizationWithOwner,
} from './utils/db-admin';

async function signUpAndSignIn(
  app: INestApplication,
  label: string,
): Promise<{ userId: string; accessToken: string }> {
  const email = uniqueTestEmail(label);
  const password = 'correct-horse-battery';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: label, email, password })
    .expect(201);
  const signIn = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password })
    .expect(200);
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

describe('Course PATCH cannot change the lifecycle status (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('PATCH with status published/archived/draft is refused (400) and changes nothing; the field edits and the dedicated publish endpoint still work', async () => {
    const owner = await signUpAndSignIn(app, 'cspb-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'cspb-org');
    await seedActiveSubscriptionForOrg(admin, org.id, 'cspb-sub');
    const academy = await seedAcademy(admin, org.id, 'cspb-academy');
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, 'CSPB Course');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };
    const path = `/academies/${academy.id}/courses/${course.id}`;

    for (const status of ['published', 'archived', 'draft']) {
      await request(app.getHttpServer())
        .patch(path)
        .set(auth)
        .send({ status })
        .expect(400);
      // Mixed with a legitimate edit: still refused as a whole.
      await request(app.getHttpServer())
        .patch(path)
        .set(auth)
        .send({ title: 'Sneaky', status })
        .expect(400);
    }
    const unchanged = await admin.course.findUniqueOrThrow({ where: { id: course.id } });
    expect(unchanged.status).toBe('draft');
    expect(unchanged.title).toBe(course.title);

    await request(app.getHttpServer())
      .patch(path)
      .set(auth)
      .send({ title: 'CSPB Renamed' })
      .expect(200);

    await request(app.getHttpServer()).post(`${path}/publish`).set(auth).expect(200);
    const published = await admin.course.findUniqueOrThrow({ where: { id: course.id } });
    expect(published.status).toBe('published');
    expect(published.title).toBe('CSPB Renamed');
  });
});
