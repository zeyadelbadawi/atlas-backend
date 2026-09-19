/**
 * P64 Phase 1 — regressions for the four defects that only real browser
 * validation surfaced. Each test states the exact user-visible symptom it
 * locks down, because none of them were reachable from the seeded data
 * the other specs build (every seeded enrollment happened to point at a
 * published, public course, and no spec blocked a student who was
 * actually signed in).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

describe('P64 Phase 1 — defects found in browser validation (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function staffAccount(label: string) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  /** An academy whose course is DRAFT + PRIVATE — the case staff manual enrollment exists for. */
  async function privateCourseWorld(label: string) {
    const owner = await staffAccount(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'draft',
      visibility: 'private',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, `${label}-s`, 0);
    await seedCourseLesson(admin, section.id, course.id, `${label}-l`, 0, {
      status: 'published',
    });
    return { owner, org, academy, course };
  }

  async function learner(label: string, academyId: string) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD, academyId })
      .expect(201);
    return { email, ...(await signInLearner(email, academyId)) };
  }

  async function signInLearner(email: string, academyId: string) {
    await flushRateLimitKeys();
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD, surface: 'academy', academyId })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      accessToken: signIn.body.accessToken as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  it('lists the learner’s own enrollment when the course is draft and private', async () => {
    // Symptom: HTTP 500 — "Field course is required to return data, got
    // `null`" — because no `courses` SELECT tier admitted an enrolled
    // student to a non-public course.
    const w = await privateCourseWorld('private-course');
    const student = await learner('private-course-student', w.academy.id);

    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/students/${student.userId}/enrollments`)
      .set(w.owner.auth)
      .send({ courseId: w.course.id })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/enrollments')
      .set(student.auth)
      .expect(200);

    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].course).toMatchObject({
      id: w.course.id,
      status: 'draft',
      visibility: 'private',
    });
    expect(list.body.items[0].isActive).toBe(true);
  });

  it('does not show that private course to a different learner of the same academy', async () => {
    const w = await privateCourseWorld('private-course-scope');
    const enrolled = await learner('private-scope-in', w.academy.id);
    const other = await learner('private-scope-out', w.academy.id);

    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/students/${enrolled.userId}/enrollments`)
      .set(w.owner.auth)
      .send({ courseId: w.course.id })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get('/enrollments')
      .set(other.auth)
      .expect(200);
    expect(list.body.items).toHaveLength(0);

    // ...and the content itself stays closed to them.
    await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/sections`)
      .set(other.auth)
      .expect(404);
  });

  it('reports an expired enrollment as inactive to both the learner and the roster', async () => {
    // Symptom: the roster said "1 active of 1" while the learner was
    // already being refused the content, and My Learning offered a Start
    // Course button that 404ed.
    const w = await privateCourseWorld('expiry-count');
    const student = await learner('expiry-count-student', w.academy.id);

    const enrollment = await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/students/${student.userId}/enrollments`)
      .set(w.owner.auth)
      .send({ courseId: w.course.id })
      .expect(201);

    await admin.enrollment.update({
      where: { id: enrollment.body.id as string },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const roster = await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/students`)
      .set(w.owner.auth)
      .expect(200);
    const row = roster.body.items.find(
      (item: { userId: string }) => item.userId === student.userId,
    );
    expect(row).toMatchObject({ enrollmentCount: 1, activeEnrollmentCount: 0 });

    const list = await request(app.getHttpServer())
      .get('/enrollments')
      .set(student.auth)
      .expect(200);
    expect(list.body.items[0]).toMatchObject({ status: 'enrolled', isActive: false });
    expect(list.body.items[0].expiresAt).toBeDefined();

    await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/sections`)
      .set(student.auth)
      .expect(404);
  });

  it('reports a revoked enrollment as inactive and carries the revocation timestamp', async () => {
    const w = await privateCourseWorld('revoke-flag');
    const student = await learner('revoke-flag-student', w.academy.id);
    const enrollment = await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/students/${student.userId}/enrollments`)
      .set(w.owner.auth)
      .send({ courseId: w.course.id })
      .expect(201);

    await request(app.getHttpServer())
      .post(
        `/academies/${w.academy.id}/enrollments/${enrollment.body.id as string}/revoke`,
      )
      .set(w.owner.auth)
      .send({ reason: 'manual' })
      .expect(200);

    const list = await request(app.getHttpServer())
      .get('/enrollments')
      .set(student.auth)
      .expect(200);
    expect(list.body.items[0]).toMatchObject({ status: 'unavailable', isActive: false });
    expect(list.body.items[0].revokedAt).toBeDefined();
  });

  it('blocking a student ends the sessions they already hold on that academy', async () => {
    // Symptom: a blocked learner stayed signed in on the academy site
    // until their access token expired — every content read was refused,
    // but the session itself lived on.
    const w = await privateCourseWorld('block-session');
    const student = await learner('block-session-student', w.academy.id);

    await request(app.getHttpServer()).get('/users/me').set(student.auth).expect(200);

    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/students/${student.userId}/block`)
      .set(w.owner.auth)
      .send({ reason: 'browser validation' })
      .expect(200);

    await request(app.getHttpServer()).get('/users/me').set(student.auth).expect(401);

    const rows = await admin.refreshToken.findMany({
      where: { userId: student.userId, revokedAt: null },
    });
    expect(rows).toHaveLength(0);
  });

  it('a block by one academy leaves the learner’s session on another academy alone', async () => {
    const a = await privateCourseWorld('block-scope-a');
    const b = await privateCourseWorld('block-scope-b');

    const student = await learner('block-scope-student', a.academy.id);
    // Joining B happens through B's own sign-in (its policy is `open`).
    const onB = await signInLearner(student.email, b.academy.id);

    await request(app.getHttpServer())
      .post(`/academies/${a.academy.id}/students/${student.userId}/block`)
      .set(a.owner.auth)
      .send({})
      .expect(200);

    await request(app.getHttpServer()).get('/users/me').set(student.auth).expect(401);
    await request(app.getHttpServer()).get('/users/me').set(onB.auth).expect(200);
  });
});
