/**
 * W6/W7 — guided course wizard backend contract (e2e).
 *
 *   - `GET /academies/:id/courses/:courseId/publish-readiness`: the shared
 *     evaluator's verdict (a quiz-only course IS ready; a paid course with
 *     no price is NOT), advisory only (publishing an unready course still
 *     works in Phase 1), and authorized exactly like course management.
 *   - Idempotent course create (`idempotencyKey`): a replay — sequential
 *     or concurrent — returns the same course; another user's key conflicts.
 *   - Quiz authoring contract: a unit placement must belong to the course
 *     and appends; `null` clears passing score / max attempts / description
 *     and detaches a unit; `null` for a NOT NULL field is a 400, not a 500.
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
  seedQuiz,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

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

const QUESTION = {
  prompt: 'What is 2 + 2?',
  type: 'single_choice' as const,
  options: [
    { label: '3', isCorrect: false },
    { label: '4', isCorrect: true },
  ],
};

interface Check {
  key: string;
  status: 'pass' | 'fail';
  severity: 'blocking' | 'warning' | 'info';
  step: string;
}

function check(body: { checks: Check[] }, key: string): Check {
  const found = body.checks.find((c) => c.key === key);
  if (!found) throw new Error(`missing check ${key}`);
  return found;
}

describe('Course wizard — readiness, idempotent create, quiz contract (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  let owner: { userId: string; accessToken: string };
  let organizationId: string;
  let academyId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;

    owner = await signUpAndSignIn(app, 'w6-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'w6-org');
    organizationId = org.id;
    await seedActiveSubscriptionForOrg(admin, org.id, 'w6');
    const academy = await seedAcademy(admin, org.id, 'w6-academy');
    academyId = academy.id;
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const readiness = (courseId: string, token = owner.accessToken) =>
    request(app.getHttpServer())
      .get(`/academies/${academyId}/courses/${courseId}/publish-readiness`)
      .set('Authorization', `Bearer ${token}`);

  // ---------------------------------------------------------------- readiness

  it('readiness: an empty draft is not ready; drafts-only is still not ready', async () => {
    const course = await seedCourse(admin, academyId, 'W6 Empty');
    const empty = await readiness(course.id).expect(200);
    expect(empty.body).toMatchObject({
      courseId: course.id,
      ready: false,
      enforced: false,
    });
    expect(check(empty.body, 'publishedActivity')).toMatchObject({
      status: 'fail',
      severity: 'blocking',
      step: 'curriculum',
    });
    expect(check(empty.body, 'paidPrice').status).toBe('pass'); // free course
    expect(check(empty.body, 'title').status).toBe('pass');

    // A draft lesson is not a learner-visible activity.
    const section = await seedCourseSection(admin, course.id, 'Unit 1', 0);
    await seedCourseLesson(admin, section.id, course.id, 'Draft lesson', 0);
    const drafts = await readiness(course.id).expect(200);
    expect(drafts.body.ready).toBe(false);
    expect(drafts.body.counts).toMatchObject({
      sections: 1,
      emptySections: 0,
      lessons: 1,
      publishedLessons: 0,
      draftItems: 1,
    });
    expect(check(drafts.body, 'draftItems').status).toBe('fail');
  });

  it('readiness: a QUIZ-ONLY course (one published quiz, no lessons) is ready', async () => {
    const course = await seedCourse(admin, academyId, 'W6 Quiz Only', {
      shortDescription: 'Short',
      description: 'Long',
      outcomes: ['Add numbers'],
    });
    await seedQuiz(admin, course.id, 'Only quiz', { status: 'published' });
    const res = await readiness(course.id).expect(200);
    expect(res.body.ready).toBe(true);
    expect(check(res.body, 'publishedActivity').status).toBe('pass');
    expect(res.body.counts).toMatchObject({
      lessons: 0,
      publishedQuizzes: 1,
      sections: 0,
    });
    // Warnings never block.
    expect(check(res.body, 'thumbnail')).toMatchObject({
      status: 'fail',
      severity: 'warning',
      step: 'media',
    });
    expect(check(res.body, 'visibilityPrivate').severity).toBe('info');
  });

  it('readiness: a PAID course without a price is blocked; with one it passes (payment setup is a warning)', async () => {
    const course = await seedCourse(admin, academyId, 'W6 Paid', {
      pricingType: 'paid',
    });
    const section = await seedCourseSection(admin, course.id, 'Unit 1', 0);
    await seedCourseLesson(admin, section.id, course.id, 'Lesson', 0, {
      status: 'published',
    });

    const blocked = await readiness(course.id).expect(200);
    expect(blocked.body.ready).toBe(false);
    expect(check(blocked.body, 'paidPrice')).toMatchObject({
      status: 'fail',
      severity: 'blocking',
      step: 'pricing',
    });
    expect(check(blocked.body, 'publishedActivity').status).toBe('pass');
    // No organization payment settings row = unconfigured.
    expect(check(blocked.body, 'paymentSetup')).toMatchObject({
      status: 'fail',
      severity: 'warning',
    });

    await request(app.getHttpServer())
      .patch(`/academies/${academyId}/courses/${course.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ pricing: { type: 'paid', amount: 49.5, currency: 'USD' } })
      .expect(200);
    const priced = await readiness(course.id).expect(200);
    expect(check(priced.body, 'paidPrice').status).toBe('pass');
    expect(priced.body.ready).toBe(true);
  });

  it('readiness is ADVISORY in Phase 1: publishing an unready course still succeeds', async () => {
    const course = await seedCourse(admin, academyId, 'W6 Unready Publish');
    const res = await readiness(course.id).expect(200);
    expect(res.body.ready).toBe(false);
    const published = await request(app.getHttpServer())
      .post(`/academies/${academyId}/courses/${course.id}/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(published.body.status).toBe('published');
  });

  it('readiness authorization: unauthenticated 401; instructor and plain member refused; other academy 404', async () => {
    const course = await seedCourse(admin, academyId, 'W6 Authz');

    await request(app.getHttpServer())
      .get(`/academies/${academyId}/courses/${course.id}/publish-readiness`)
      .expect(401);

    // An academy instructor authors content but does not manage courses.
    const instructor = await signUpAndSignIn(app, 'w6-instructor');
    await seedMembership(admin, organizationId, instructor.userId, 'instructor');
    await seedAcademyMember(admin, academyId, instructor.userId, 'instructor');
    await readiness(course.id, instructor.accessToken).expect(403);

    // An organization member with no academy role at all.
    const member = await signUpAndSignIn(app, 'w6-member');
    await seedMembership(admin, organizationId, member.userId, 'member');
    await readiness(course.id, member.accessToken).expect(403);

    // An outsider (no membership in the organization).
    const outsider = await signUpAndSignIn(app, 'w6-outsider');
    const outsiderRes = await readiness(course.id, outsider.accessToken);
    expect([403, 404]).toContain(outsiderRes.status);

    // A course of ANOTHER academy addressed through this academy's path.
    const otherAcademy = await seedAcademy(admin, organizationId, 'w6-other-academy');
    const foreign = await seedCourse(admin, otherAcademy.id, 'W6 Foreign');
    await readiness(foreign.id).expect(404);

    // A manager of this academy may read it.
    const manager = await signUpAndSignIn(app, 'w6-manager');
    await seedMembership(admin, organizationId, manager.userId, 'manager');
    await seedAcademyMember(admin, academyId, manager.userId, 'manager');
    await readiness(course.id, manager.accessToken).expect(200);
  });

  // ------------------------------------------------------- idempotent create

  it('idempotent create: the same key returns the same course (sequential replay)', async () => {
    const key = `w6-key-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = {
      title: 'Idempotent Course',
      slug: `idem-${Date.now()}`,
      visibility: 'private',
      pricing: { type: 'free' },
      idempotencyKey: key,
    };
    const first = await request(app.getHttpServer())
      .post(`/academies/${academyId}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(body)
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post(`/academies/${academyId}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body).not.toHaveProperty('idempotencyKey');
    expect(replay.body).not.toHaveProperty('creationIdempotencyKey');

    const rows = await admin.course.count({
      where: { academyId, creationIdempotencyKey: key },
    });
    expect(rows).toBe(1);
    // Exactly one creation audited.
    const audits = await admin.auditLogEntry.count({
      where: { action: 'course.created', targetId: first.body.id },
    });
    expect(audits).toBe(1);

    // Without a key the old behaviour stands: same slug = 409 slugTaken.
    const { idempotencyKey: _ignored, ...withoutKey } = body;
    void _ignored;
    const conflict = await request(app.getHttpServer())
      .post(`/academies/${academyId}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(withoutKey)
      .expect(409);
    expect(conflict.body.error.messageKey).toBe('errors.course.slugTaken');
  });

  it('idempotent create: two CONCURRENT requests with one key make one course', async () => {
    const key = `w6-race-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = {
      title: 'Raced Course',
      slug: `raced-${Date.now()}`,
      visibility: 'private',
      pricing: { type: 'free' },
      idempotencyKey: key,
    };
    const send = () =>
      request(app.getHttpServer())
        .post(`/academies/${academyId}/courses`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send(body);
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).toBe(b.body.id);
    expect(
      await admin.course.count({ where: { academyId, creationIdempotencyKey: key } }),
    ).toBe(1);
  });

  it("idempotent create: another user's key conflicts; a malformed key is a 400", async () => {
    const key = `w6-shared-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await request(app.getHttpServer())
      .post(`/academies/${academyId}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Owner Course',
        slug: `owner-${Date.now()}`,
        visibility: 'private',
        pricing: { type: 'free' },
        idempotencyKey: key,
      })
      .expect(201);

    const manager = await signUpAndSignIn(app, 'w6-key-manager');
    await seedMembership(admin, organizationId, manager.userId, 'manager');
    await seedAcademyMember(admin, academyId, manager.userId, 'manager');
    const reused = await request(app.getHttpServer())
      .post(`/academies/${academyId}/courses`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Manager Course',
        slug: `manager-${Date.now()}`,
        visibility: 'private',
        pricing: { type: 'free' },
        idempotencyKey: key,
      })
      .expect(409);
    expect(reused.body.error.messageKey).toBe('errors.course.idempotencyKeyConflict');

    await request(app.getHttpServer())
      .post(`/academies/${academyId}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Bad Key',
        slug: `bad-key-${Date.now()}`,
        visibility: 'private',
        pricing: { type: 'free' },
        idempotencyKey: 'has spaces!',
      })
      .expect(400);
  });

  // ----------------------------------------------------------- quiz contract

  it('quiz: a unit of ANOTHER course is refused on create and on update', async () => {
    const course = await seedCourse(admin, academyId, 'W7 Quiz Course');
    const other = await seedCourse(admin, academyId, 'W7 Other Course');
    const foreignSection = await seedCourseSection(admin, other.id, 'Foreign unit', 0);

    const refused = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Q', sectionId: foreignSection.id, questions: [QUESTION] })
      .expect(400);
    expect(refused.body.error.violations).toEqual([
      expect.objectContaining({
        field: 'sectionId',
        messageKey: 'errors.quiz.sectionNotInCourse',
      }),
    ]);
    expect(await admin.quiz.count({ where: { courseId: course.id } })).toBe(0);

    const created = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Q', questions: [QUESTION] })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/courses/${course.id}/quizzes/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ sectionId: foreignSection.id })
      .expect(400);
  });

  it('quiz: created into a unit it is APPENDED after the existing items', async () => {
    const course = await seedCourse(admin, academyId, 'W7 Append Course');
    const section = await seedCourseSection(admin, course.id, 'Unit', 0);
    await seedCourseLesson(admin, section.id, course.id, 'L0', 0);
    await seedCourseLesson(admin, section.id, course.id, 'L1', 1);

    const created = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Appended', sectionId: section.id, questions: [QUESTION] })
      .expect(201);
    const row = await admin.quiz.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.sectionId).toBe(section.id);
    expect(row.order).toBe(2);

    const items = await request(app.getHttpServer())
      .get(`/academies/${academyId}/courses/${course.id}/sections/${section.id}/items`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect((items.body as { id: string }[]).map((i) => i.id).at(-1)).toBe(
      created.body.id,
    );
  });

  it('quiz: null clears passing score, max attempts and description, and detaches the unit; omitted keeps', async () => {
    const course = await seedCourse(admin, academyId, 'W7 Clear Course');
    const section = await seedCourseSection(admin, course.id, 'Unit', 0);
    const created = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Clearable',
        description: 'Some text',
        sectionId: section.id,
        passingScore: 70,
        maxAttempts: 3,
        questions: [QUESTION],
      })
      .expect(201);
    const quizId = created.body.id as string;

    // Omitting a field keeps it.
    const renamed = await request(app.getHttpServer())
      .patch(`/courses/${course.id}/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Renamed' })
      .expect(200);
    expect(renamed.body).toMatchObject({ passingScore: 70, maxAttempts: 3 });

    const cleared = await request(app.getHttpServer())
      .patch(`/courses/${course.id}/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ passingScore: null, maxAttempts: null, description: null, sectionId: null })
      .expect(200);
    expect(cleared.body.passingScore ?? null).toBeNull();
    expect(cleared.body.maxAttempts ?? null).toBeNull();
    expect(cleared.body.description ?? null).toBeNull();
    const row = await admin.quiz.findUniqueOrThrow({ where: { id: quizId } });
    expect(row).toMatchObject({
      passingScore: null,
      maxAttempts: null,
      description: null,
      sectionId: null,
    });
  });

  it('quiz: null for a NOT NULL field is a 400, never a 500', async () => {
    const course = await seedCourse(admin, academyId, 'W7 NotNull Course');
    const created = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Strict', questions: [QUESTION] })
      .expect(201);
    for (const body of [
      { title: null },
      { status: null },
      { mode: null },
      { showAnswers: null },
    ]) {
      await request(app.getHttpServer())
        .patch(`/courses/${course.id}/quizzes/${created.body.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send(body)
        .expect(400);
    }
    // Nullable settings still clear with null.
    await request(app.getHttpServer())
      .patch(`/courses/${course.id}/quizzes/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ timeLimitSeconds: null, questionsPerAttempt: null })
      .expect(200);
  });

  it('quiz: cross-field setting errors name their field (so the form can show them)', async () => {
    const course = await seedCourse(admin, academyId, 'W7 Fields Course');
    const res = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Too many', questionsPerAttempt: 5, questions: [QUESTION] })
      .expect(400);
    expect(res.body.error.violations).toEqual([
      expect.objectContaining({ field: 'questionsPerAttempt' }),
    ]);
    const due = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Late due',
        availableUntil: '2030-01-01T00:00:00.000Z',
        dueAt: '2030-02-01T00:00:00.000Z',
        questions: [QUESTION],
      })
      .expect(400);
    expect(due.body.error.violations).toEqual([
      expect.objectContaining({ field: 'dueAt' }),
    ]);
  });
});
