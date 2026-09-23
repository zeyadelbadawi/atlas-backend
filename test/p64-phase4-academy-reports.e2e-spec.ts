/**
 * P64 Phase 4 — Owner reports e2e (master plan §D.6/§E.5/§O).
 *
 * Proves the two academy-scoped aggregates end to end against real Postgres
 * with RLS: an owner/manager reads exact integrity and sharing numbers for
 * THEIR academy over a bounded window; an instructor or staff member (an
 * academy member outside the reporting roles) is refused 403 — the service
 * gate and `content_access_log_manager_select` / `can_manage_academy_students`
 * agreeing; a learner and an outsider never reach the data; rows older than
 * the window are excluded; the window is bounded (1–90 days).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedEnrollment,
  seedOrganizationWithOwner,
  seedQuiz,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

describe('Owner reports (e2e)', () => {
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

  async function account(label: string) {
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
    return {
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  /** An academy with every role, one published course + lesson + quiz, and two learners. */
  async function world(label: string) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

    const manager = await account(`${label}-manager`);
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');
    const instructor = await account(`${label}-instructor`);
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');
    const staff = await account(`${label}-staff`);
    await seedAcademyMember(admin, academy.id, staff.userId, 'staff');

    const course = await seedCourse(admin, academy.id, `${label}-course`, {
      status: 'published',
      visibility: 'public',
    });
    const section = await seedCourseSection(admin, course.id, 'S1', 0);
    const lesson = await seedCourseLesson(admin, section.id, course.id, 'L1', 0, {
      status: 'published',
    });
    const quiz = await seedQuiz(admin, course.id, `${label}-quiz`);

    const learnerA = await account(`${label}-learner-a`);
    await seedAcademyStudent(admin, academy.id, learnerA.userId);
    await seedEnrollment(admin, learnerA.userId, course.id, academy.id);
    const learnerB = await account(`${label}-learner-b`);
    await seedAcademyStudent(admin, academy.id, learnerB.userId);
    await seedEnrollment(admin, learnerB.userId, course.id, academy.id);

    return {
      owner,
      manager,
      instructor,
      staff,
      org,
      academy,
      course,
      lesson,
      quiz,
      learnerA,
      learnerB,
    };
  }

  async function attemptWithEvents(
    quizId: string,
    studentId: string,
    attemptNumber: number,
    events: readonly { type: string; counted: boolean; at?: Date }[],
  ) {
    const attempt = await admin.quizAttempt.create({
      data: {
        quizId,
        studentId,
        status: 'submitted',
        answers: [],
        score: 0,
        passed: false,
        attemptNumber,
        submittedAt: new Date(),
      },
    });
    for (const event of events) {
      await admin.quizAttemptEvent.create({
        data: {
          attemptId: attempt.id,
          type: event.type as never,
          counted: event.counted,
          serverAt: event.at ?? new Date(),
        },
      });
    }
    return attempt;
  }

  async function accessLog(
    w: Awaited<ReturnType<typeof world>>,
    row: {
      result: 'granted' | 'refused';
      reason?: string;
      userId?: string;
      deviceId?: string;
      at?: Date;
    },
  ) {
    await admin.contentAccessLog.create({
      data: {
        academyId: w.academy.id,
        courseId: w.course.id,
        lessonId: w.lesson.id,
        result: row.result,
        reason: row.reason,
        userId: row.userId,
        deviceId: row.deviceId,
        createdAt: row.at ?? new Date(),
      },
    });
  }

  async function seedSignals(w: Awaited<ReturnType<typeof world>>) {
    // Integrity: attempt 1 → 4 events (3 counted), attempt 2 → 1 counted event,
    // plus one counted event 100 days old that must fall outside every window.
    await attemptWithEvents(w.quiz.id, w.learnerA.userId, 1, [
      { type: 'blur', counted: true },
      { type: 'copy', counted: true },
      { type: 'heartbeat', counted: false },
      { type: 'visibility_hidden', counted: true },
    ]);
    await attemptWithEvents(w.quiz.id, w.learnerB.userId, 1, [
      { type: 'paste', counted: true },
    ]);
    await attemptWithEvents(w.quiz.id, w.learnerB.userId, 2, [
      { type: 'blur', counted: true, at: daysAgo(100) },
    ]);

    // Sharing: 3 granted; refused = deviceLimit×2 (learner A, devices d1,d2)
    // + sessionConflict×1 (learner B, d3); one old refusal outside the window.
    await accessLog(w, { result: 'granted', userId: w.learnerA.userId, deviceId: 'd1' });
    await accessLog(w, { result: 'granted', userId: w.learnerA.userId, deviceId: 'd1' });
    await accessLog(w, { result: 'granted', userId: w.learnerB.userId, deviceId: 'd3' });
    await accessLog(w, {
      result: 'refused',
      reason: 'deviceLimit',
      userId: w.learnerA.userId,
      deviceId: 'd1',
    });
    await accessLog(w, {
      result: 'refused',
      reason: 'deviceLimit',
      userId: w.learnerA.userId,
      deviceId: 'd2',
    });
    await accessLog(w, {
      result: 'refused',
      reason: 'sessionConflict',
      userId: w.learnerB.userId,
      deviceId: 'd3',
    });
    await accessLog(w, {
      result: 'refused',
      reason: 'deviceLimit',
      userId: w.learnerB.userId,
      deviceId: 'd9',
      at: daysAgo(100),
    });
  }

  const integrityPath = (academyId: string, q = '') =>
    `/academies/${academyId}/reports/integrity${q}`;
  const sharingPath = (academyId: string, q = '') =>
    `/academies/${academyId}/reports/sharing${q}`;

  it('the owner reads exact integrity aggregates for the default 30-day window', async () => {
    const w = await world('rep-int');
    await seedSignals(w);

    const res = await request(app.getHttpServer())
      .get(integrityPath(w.academy.id))
      .set(w.owner.auth)
      .expect(200);

    expect(res.body.academyId).toBe(w.academy.id);
    expect(res.body.window.days).toBe(30);
    expect(res.body.totalEvents).toBe(5);
    expect(res.body.countedEvents).toBe(4);
    expect(res.body.attemptsWithEvents).toBe(2);
    expect(res.body.byType).toEqual({
      blur: 1,
      copy: 1,
      heartbeat: 1,
      paste: 1,
      visibility_hidden: 1,
    });
    expect(res.body.topCourses).toEqual([
      {
        courseId: w.course.id,
        courseTitle: w.course.title,
        events: 5,
        attemptsWithEvents: 2,
      },
    ]);
    expect(res.body.truncated).toBe(false);
  });

  it('the owner reads exact sharing aggregates; the 100-day-old refusal is excluded even at 90 days', async () => {
    const w = await world('rep-share');
    await seedSignals(w);

    for (const q of ['', '?days=90']) {
      const res = await request(app.getHttpServer())
        .get(sharingPath(w.academy.id, q))
        .set(w.owner.auth)
        .expect(200);

      expect(res.body.granted).toBe(3);
      expect(res.body.refused).toBe(3);
      expect(res.body.refusedByReason).toEqual({ deviceLimit: 2, sessionConflict: 1 });
      expect(res.body.distinctUsersRefused).toBe(2);
      expect(res.body.distinctDevicesRefused).toBe(3);
      expect(res.body.topCourses).toEqual([
        { courseId: w.course.id, courseTitle: w.course.title, refusals: 3 },
      ]);
      expect(res.body.topUsers[0]).toMatchObject({
        userId: w.learnerA.userId,
        refusals: 2,
      });
      // Display name only — never an email or device fingerprint.
      expect(res.body.topUsers[0].userName).toBe(`rep-share-learner-a`);
      expect(JSON.stringify(res.body)).not.toContain('@');
      expect(res.body.truncated).toBe(false);
    }
  });

  it('a manager can read both reports (the RLS manager_select role set)', async () => {
    const w = await world('rep-manager');
    await seedSignals(w);

    const integrity = await request(app.getHttpServer())
      .get(integrityPath(w.academy.id))
      .set(w.manager.auth)
      .expect(200);
    expect(integrity.body.totalEvents).toBe(5);

    const sharing = await request(app.getHttpServer())
      .get(sharingPath(w.academy.id))
      .set(w.manager.auth)
      .expect(200);
    expect(sharing.body.refused).toBe(3);
  });

  it('an instructor and a staff member are refused (403) — members outside the reporting roles', async () => {
    const w = await world('rep-roles');
    for (const actor of [w.instructor, w.staff]) {
      await request(app.getHttpServer())
        .get(integrityPath(w.academy.id))
        .set(actor.auth)
        .expect(403);
      await request(app.getHttpServer())
        .get(sharingPath(w.academy.id))
        .set(actor.auth)
        .expect(403);
    }
  });

  it("a learner and another academy's owner never reach the data", async () => {
    const w = await world('rep-iso-a');
    // A minimal second academy (owner only) — a full `world()` here would
    // push one test past the auth rate limit, which is a fixture cost, not
    // a property under test.
    const outsider = await account('rep-iso-b-owner');
    const otherOrg = await seedOrganizationWithOwner(
      admin,
      outsider.userId,
      'rep-iso-b-org',
    );
    await seedActiveSubscriptionForOrg(admin, otherOrg.id, 'rep-iso-b');
    const otherAcademy = await seedAcademy(admin, otherOrg.id, 'rep-iso-b-academy');
    await seedAcademyMember(admin, otherAcademy.id, outsider.userId, 'owner');
    await seedSignals(w);

    for (const actor of [w.learnerA, outsider]) {
      for (const path of [integrityPath(w.academy.id), sharingPath(w.academy.id)]) {
        const res = await request(app.getHttpServer()).get(path).set(actor.auth);
        expect([403, 404]).toContain(res.status);
        expect(res.body.totalEvents).toBeUndefined();
        expect(res.body.refused).toBeUndefined();
      }
    }
  });

  it('bounds the window: days must be 1–90', async () => {
    const w = await world('rep-window');
    for (const q of ['?days=0', '?days=91', '?days=abc']) {
      await request(app.getHttpServer())
        .get(integrityPath(w.academy.id, q))
        .set(w.owner.auth)
        .expect(400);
    }
    await request(app.getHttpServer())
      .get(integrityPath(w.academy.id, '?days=1'))
      .set(w.owner.auth)
      .expect(200);
  });

  it('requires authentication (401)', async () => {
    await request(app.getHttpServer()).get(integrityPath('x')).expect(401);
    await request(app.getHttpServer()).get(sharingPath('x')).expect(401);
  });
});
