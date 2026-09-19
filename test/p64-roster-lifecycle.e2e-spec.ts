/**
 * P64 Phase 1 — the student roster and the staff-side enrollment lifecycle
 * (master plan Findings F4/F5, Section H).
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
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

describe('P64 Phase 1 — roster and enrollment lifecycle (e2e)', () => {
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

  async function academyWorld(label: string) {
    const owner = await staffAccount(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

    const manager = await staffAccount(`${label}-manager`);
    await seedMembership(admin, org.id, manager.userId, 'manager');
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');

    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, `${label}-s`, 0);
    await seedCourseLesson(admin, section.id, course.id, `${label}-l`, 0, {
      status: 'published',
    });
    return { owner, manager, org, academy, course };
  }

  async function learner(label: string, academyId: string) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD, academyId })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD, surface: 'academy', academyId })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  it('a learner who registers through the academy website appears on the roster immediately', async () => {
    const w = await academyWorld('roster-appears');
    const student = await learner('roster-appears-student', w.academy.id);

    const roster = await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/students`)
      .set(w.owner.auth)
      .expect(200);

    const row = roster.body.items.find(
      (item: { userId: string }) => item.userId === student.userId,
    );
    expect(row).toMatchObject({
      email: student.email,
      membershipStatus: 'active',
      blocked: false,
      source: 'self_signup',
      enrollmentCount: 0,
    });
    expect(roster.body.pagination.totalItems).toBeGreaterThan(0);
  });

  it('search, status filter and pagination work server-side', async () => {
    const w = await academyWorld('roster-search');
    const target = await learner('roster-search-target', w.academy.id);
    await learner('roster-search-other', w.academy.id);

    const searched = await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/students`)
      .query({ search: target.email.split('@')[0] })
      .set(w.owner.auth)
      .expect(200);
    expect(searched.body.items).toHaveLength(1);
    expect(searched.body.items[0].userId).toBe(target.userId);

    const paged = await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/students`)
      .query({ page: 1, pageSize: 1 })
      .set(w.owner.auth)
      .expect(200);
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.pagination.totalItems).toBe(2);

    const blockedOnly = await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/students`)
      .query({ status: 'blocked' })
      .set(w.owner.auth)
      .expect(200);
    expect(blockedOnly.body.items).toHaveLength(0);
  });

  it('the student detail carries enrollments, progress and outcomes', async () => {
    const w = await academyWorld('roster-detail');
    const student = await learner('roster-detail-student', w.academy.id);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set(student.auth)
      .send({ courseId: w.course.id })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/students/${student.userId}`)
      .set(w.manager.auth)
      .expect(200);

    expect(detail.body.student.userId).toBe(student.userId);
    expect(detail.body.enrollments).toHaveLength(1);
    expect(detail.body.enrollments[0]).toMatchObject({
      courseId: w.course.id,
      isActive: true,
      accessSource: 'free',
    });
    expect(detail.body.enrollments[0].progress.totalLessons).toBe(1);
    expect(detail.body.viewerScope).toBe('academy');
    expect(detail.body.activeSessionCount).toBeGreaterThanOrEqual(1);
  });

  it('blocking a student ends course access at once and unblocking restores it', async () => {
    const w = await academyWorld('roster-block');
    const student = await learner('roster-block-student', w.academy.id);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set(student.auth)
      .send({ courseId: w.course.id })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/sections`)
      .set(student.auth)
      .expect(200);

    const blocked = await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/students/${student.userId}/block`)
      .set(w.owner.auth)
      .send({ reason: 'Payment dispute' })
      .expect(200);
    expect(blocked.body).toMatchObject({
      blocked: true,
      blockedReason: 'Payment dispute',
    });

    // Blocking ends the session the learner already holds on this academy
    // (browser validation found it surviving), so the old token is refused
    // outright — 401 — before any course-access check even runs.
    await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/sections`)
      .set(student.auth)
      .expect(401);
    await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/progress`)
      .set(student.auth)
      .expect(401);
    // ...and they cannot start a new one either.
    await flushRateLimitKeys();
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({
        email: student.email,
        password: PASSWORD,
        surface: 'academy',
        academyId: w.academy.id,
      })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/students/${student.userId}/unblock`)
      .set(w.owner.auth)
      .expect(200);

    await flushRateLimitKeys();
    const back = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({
        email: student.email,
        password: PASSWORD,
        surface: 'academy',
        academyId: w.academy.id,
      })
      .expect(200);
    await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/sections`)
      .set({ Authorization: `Bearer ${back.body.accessToken as string}` })
      .expect(200);
  });

  it('staff can enroll a student manually, revoke access and extend expiry', async () => {
    const w = await academyWorld('lifecycle');
    const student = await learner('lifecycle-student', w.academy.id);

    const enrolled = await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/students/${student.userId}/enrollments`)
      .set(w.manager.auth)
      .send({ courseId: w.course.id })
      .expect(201);
    expect(enrolled.body).toMatchObject({ accessSource: 'manual', isActive: true });
    await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/sections`)
      .set(student.auth)
      .expect(200);

    // Enrolling twice is refused rather than duplicating access.
    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/students/${student.userId}/enrollments`)
      .set(w.manager.auth)
      .send({ courseId: w.course.id })
      .expect(409);

    const revoked = await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/enrollments/${enrolled.body.id}/revoke`)
      .set(w.manager.auth)
      .send({ reason: 'manual' })
      .expect(200);
    expect(revoked.body).toMatchObject({ isActive: false, revokeReason: 'manual' });
    await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/sections`)
      .set(student.auth)
      .expect(404);

    // Re-granting through the same endpoint restores access.
    const regranted = await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/students/${student.userId}/enrollments`)
      .set(w.manager.auth)
      .send({ courseId: w.course.id })
      .expect(201);
    expect(regranted.body.isActive).toBe(true);

    // An expiry in the past is refused; a future one is stored.
    await request(app.getHttpServer())
      .patch(`/academies/${w.academy.id}/enrollments/${regranted.body.id}/expiry`)
      .set(w.manager.auth)
      .send({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .expect(400);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const extended = await request(app.getHttpServer())
      .patch(`/academies/${w.academy.id}/enrollments/${regranted.body.id}/expiry`)
      .set(w.manager.auth)
      .send({ expiresAt: future })
      .expect(200);
    expect(extended.body.expiresAt).toBe(future);
  });

  it('an EXPIRED enrollment stops granting access without any status change', async () => {
    const w = await academyWorld('expiry');
    const student = await learner('expiry-student', w.academy.id);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set(student.auth)
      .send({ courseId: w.course.id })
      .expect(201);

    await admin.enrollment.updateMany({
      where: { studentId: student.userId, courseId: w.course.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/sections`)
      .set(student.auth)
      .expect(404);

    const row = await admin.enrollment.findFirstOrThrow({
      where: { studentId: student.userId, courseId: w.course.id },
    });
    expect(row.status).toBe('enrolled');
  });

  it('a student cannot resurrect their own revoked enrollment through the API', async () => {
    const w = await academyWorld('self-update');
    const student = await learner('self-update-student', w.academy.id);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set(student.auth)
      .send({ courseId: w.course.id })
      .expect(201);

    const enrollment = await admin.enrollment.findFirstOrThrow({
      where: { studentId: student.userId, courseId: w.course.id },
    });
    await admin.enrollment.update({
      where: { id: enrollment.id },
      data: { status: 'unavailable', revokedAt: new Date(), revokeReason: 'refund' },
    });

    // Every student-facing route now refuses, and re-enrolling does not
    // clear the revocation (the free-enrollment path returns the existing,
    // revoked row rather than granting access again).
    await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/sections`)
      .set(student.auth)
      .expect(404);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set(student.auth)
      .send({ courseId: w.course.id })
      .expect(201);

    const after = await admin.enrollment.findUniqueOrThrow({
      where: { id: enrollment.id },
    });
    expect(after.revokedAt).not.toBeNull();
    await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/sections`)
      .set(student.auth)
      .expect(404);
  });

  it('invites can be created, listed and revoked by staff only', async () => {
    const w = await academyWorld('invites');
    const created = await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/invites`)
      .set(w.manager.auth)
      .send({ email: 'invitee@example.com', maxUses: 2, expiresInDays: 3 })
      .expect(201);
    expect(created.body.token).toBeTruthy();
    expect(created.body.maxUses).toBe(2);

    const list = await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/invites`)
      .set(w.owner.auth)
      .expect(200);
    expect(list.body).toHaveLength(1);
    // The raw token is never returned again.
    expect(list.body[0].token).toBeUndefined();

    await request(app.getHttpServer())
      .delete(`/academies/${w.academy.id}/invites/${created.body.id}`)
      .set(w.owner.auth)
      .expect(204);

    const after = await admin.academyInvite.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(after.revokedAt).not.toBeNull();
  });

  it('a student can never call the roster endpoints', async () => {
    const w = await academyWorld('roster-student');
    const student = await learner('roster-student-learner', w.academy.id);

    await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/students`)
      .set(student.auth)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/students/${student.userId}/unblock`)
      .set(student.auth)
      .expect(403);
  });
});
