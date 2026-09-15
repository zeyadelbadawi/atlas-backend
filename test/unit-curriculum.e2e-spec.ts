/**
 * Unified ordered curriculum inside a Unit (P52) — functional/contract e2e.
 *
 * Proves the BEHAVIOR the feature exists for: a Unit composes its existing
 * lessons, quizzes and assignments into ONE ordered sequence; that order is
 * persisted authoritatively (not a client array); it survives a re-read
 * ("refresh"); two Units order independently; the student receives the same
 * published order as one merged list (never separate per-type lists); and
 * every authorization/ownership/isolation boundary still holds. Live
 * Sessions stay deferred — none are ever surfaced to a student here.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedCourse,
  seedCourseSection,
  seedCourseLesson,
  seedQuiz,
  seedAssignment,
  seedEnrollment,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

async function signUpAndSignIn(app: INestApplication, label: string) {
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

describe('Unit curriculum — unified ordering (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  async function arrange(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-acad`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label}-course`, {
      status: 'published',
      visibility: 'public',
    });
    return { owner, org, academy, course };
  }

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('composes lessons + quizzes + assignments into one ordered unit sequence, and reorders/persists it', async () => {
    const { owner, academy, course } = await arrange('compose');
    const unit1 = await seedCourseSection(admin, course.id, 'Unit 1', 0);

    // A lesson created in the unit, plus a course-level quiz and assignment.
    const lesson = await seedCourseLesson(admin, unit1.id, course.id, 'Intro', 0, {
      status: 'published',
    });
    const quiz = await seedQuiz(admin, course.id, 'Chapter Quiz', { status: 'published' });
    const assignment = await seedAssignment(admin, course.id, 'Homework', {
      status: 'published',
    });

    const base = `/academies/${academy.id}/courses/${course.id}/sections/${unit1.id}/items`;

    // Attach the quiz then the assignment — they append after the lesson.
    await request(app.getHttpServer())
      .post(`${base}/attach`)
      .set(auth(owner.accessToken))
      .send({ type: 'quiz', itemId: quiz.id })
      .expect(201);
    const afterAttach = await request(app.getHttpServer())
      .post(`${base}/attach`)
      .set(auth(owner.accessToken))
      .send({ type: 'assignment', itemId: assignment.id })
      .expect(201);

    expect(afterAttach.body.map((i: { id: string }) => i.id)).toEqual([
      lesson.id,
      quiz.id,
      assignment.id,
    ]);
    expect(afterAttach.body.map((i: { type: string }) => i.type)).toEqual([
      'lesson',
      'quiz',
      'assignment',
    ]);

    // Reorder to quiz, assignment, lesson.
    await request(app.getHttpServer())
      .patch(`${base}/order`)
      .set(auth(owner.accessToken))
      .send({ orderedIds: [quiz.id, assignment.id, lesson.id] })
      .expect(204);

    // Re-read ("refresh") — the new order persisted authoritatively.
    const reread = await request(app.getHttpServer())
      .get(base)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(reread.body.map((i: { id: string }) => i.id)).toEqual([
      quiz.id,
      assignment.id,
      lesson.id,
    ]);
    expect(reread.body.map((i: { order: number }) => i.order)).toEqual([0, 1, 2]);
  });

  it('keeps two units ordering independently', async () => {
    const { owner, academy, course } = await arrange('two-units');
    const u1 = await seedCourseSection(admin, course.id, 'U1', 0);
    const u2 = await seedCourseSection(admin, course.id, 'U2', 1);
    const l1 = await seedCourseLesson(admin, u1.id, course.id, 'L1', 0, { status: 'published' });
    const q1 = await seedQuiz(admin, course.id, 'Q1', { status: 'published' });
    const l2 = await seedCourseLesson(admin, u2.id, course.id, 'L2', 0, { status: 'published' });
    const q2 = await seedQuiz(admin, course.id, 'Q2', { status: 'published' });

    const items = (unit: string) =>
      `/academies/${academy.id}/courses/${course.id}/sections/${unit}/items`;

    await request(app.getHttpServer())
      .post(`${items(u1.id)}/attach`)
      .set(auth(owner.accessToken))
      .send({ type: 'quiz', itemId: q1.id })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${items(u2.id)}/attach`)
      .set(auth(owner.accessToken))
      .send({ type: 'quiz', itemId: q2.id })
      .expect(201);

    // Reorder unit 1 only; unit 2 is unaffected.
    await request(app.getHttpServer())
      .patch(`${items(u1.id)}/order`)
      .set(auth(owner.accessToken))
      .send({ orderedIds: [q1.id, l1.id] })
      .expect(204);

    const u1items = await request(app.getHttpServer())
      .get(items(u1.id))
      .set(auth(owner.accessToken))
      .expect(200);
    const u2items = await request(app.getHttpServer())
      .get(items(u2.id))
      .set(auth(owner.accessToken))
      .expect(200);

    expect(u1items.body.map((i: { id: string }) => i.id)).toEqual([q1.id, l1.id]);
    expect(u2items.body.map((i: { id: string }) => i.id)).toEqual([l2.id, q2.id]);
  });

  it('lists course-level content available to attach, and detach returns an item to course level', async () => {
    const { owner, academy, course } = await arrange('available');
    const unit = await seedCourseSection(admin, course.id, 'U', 0);
    const quiz = await seedQuiz(admin, course.id, 'Detachable', { status: 'published' });
    const base = `/academies/${academy.id}/courses/${course.id}`;

    const available = await request(app.getHttpServer())
      .get(`${base}/available-content`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(available.body.some((i: { id: string; sectionId: string | null }) =>
      i.id === quiz.id && i.sectionId === null)).toBe(true);

    await request(app.getHttpServer())
      .post(`${base}/sections/${unit.id}/items/attach`)
      .set(auth(owner.accessToken))
      .send({ type: 'quiz', itemId: quiz.id })
      .expect(201);
    await request(app.getHttpServer())
      .post(`${base}/sections/${unit.id}/items/detach`)
      .set(auth(owner.accessToken))
      .send({ type: 'quiz', itemId: quiz.id })
      .expect(201);

    const afterDetach = await request(app.getHttpServer())
      .get(`${base}/sections/${unit.id}/items`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(afterDetach.body.some((i: { id: string }) => i.id === quiz.id)).toBe(false);
    const dbQuiz = await admin.quiz.findUnique({ where: { id: quiz.id } });
    expect(dbQuiz?.sectionId).toBeNull();
  });

  it('serves the student the same published mixed order as one list (no draft, no live session)', async () => {
    const { owner, academy, course } = await arrange('student');
    const unit = await seedCourseSection(admin, course.id, 'U', 0);
    const lesson = await seedCourseLesson(admin, unit.id, course.id, 'L', 0, {
      status: 'published',
    });
    const draftLesson = await seedCourseLesson(admin, unit.id, course.id, 'Draft L', 1, {
      status: 'draft',
    });
    const quiz = await seedQuiz(admin, course.id, 'Q', { status: 'published' });
    const draftQuiz = await seedQuiz(admin, course.id, 'Draft Q', { status: 'draft' });
    const base = `/academies/${academy.id}/courses/${course.id}/sections/${unit.id}/items`;

    await request(app.getHttpServer())
      .post(`${base}/attach`).set(auth(owner.accessToken))
      .send({ type: 'quiz', itemId: quiz.id }).expect(201);
    await request(app.getHttpServer())
      .post(`${base}/attach`).set(auth(owner.accessToken))
      .send({ type: 'quiz', itemId: draftQuiz.id }).expect(201);
    // Order: quiz, lesson (draft items present but must be filtered for student)
    await request(app.getHttpServer())
      .patch(`${base}/order`).set(auth(owner.accessToken))
      .send({ orderedIds: [quiz.id, lesson.id, draftLesson.id, draftQuiz.id] }).expect(204);

    // Enrol a real student user and read the student curriculum as them.
    const student = await signUpAndSignIn(app, 'student');
    await seedAcademyStudent(admin, academy.id, student.userId);
    await seedEnrollment(admin, student.userId, course.id, academy.id);

    const res = await request(app.getHttpServer())
      .get(`/courses/${course.id}/sections`)
      .set(auth(student.accessToken))
      .expect(200);
    const section = res.body.items[0];
    expect(section.items).toBeDefined();
    const ids = section.items.map((i: { id: string }) => i.id);
    // quiz then lesson; draft lesson and draft quiz excluded; no live_session.
    expect(ids).toEqual([quiz.id, lesson.id]);
    expect(section.items.every((i: { type: string }) => i.type !== 'live_session')).toBe(true);
  });

  it('enforces authorization, ownership and academy isolation', async () => {
    const { owner, academy, course } = await arrange('authz');
    const unit = await seedCourseSection(admin, course.id, 'U', 0);
    const quiz = await seedQuiz(admin, course.id, 'Q', { status: 'published' });
    const base = `/academies/${academy.id}/courses/${course.id}/sections/${unit.id}/items`;

    // Unauthenticated -> 401.
    await request(app.getHttpServer())
      .get(base)
      .expect(401);

    // A different academy's owner cannot reach this course's unit.
    const outsider = await arrange('authz-outsider');
    await request(app.getHttpServer())
      .post(`${base}/attach`)
      .set(auth(outsider.owner.accessToken))
      .send({ type: 'quiz', itemId: quiz.id })
      .expect((r) => {
        if (![403, 404].includes(r.status)) {
          throw new Error(`expected 403/404, got ${r.status}`);
        }
      });

    // Invalid reorder set (missing an id) -> 400.
    const lesson = await seedCourseLesson(admin, unit.id, course.id, 'L', 0);
    await request(app.getHttpServer())
      .patch(`${base}/order`)
      .set(auth(owner.accessToken))
      .send({ orderedIds: [lesson.id] }) // missing nothing here (only lesson in unit) -> valid; make it invalid:
      .expect(204);
    await request(app.getHttpServer())
      .patch(`${base}/order`)
      .set(auth(owner.accessToken))
      .send({ orderedIds: [lesson.id, 'not-a-real-id'] })
      .expect(400);
  });
});
