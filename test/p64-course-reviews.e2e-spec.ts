/**
 * P64 Phase 4 — Course reviews e2e suite (master plan §D.4/§G/§H/§O).
 *
 * Proves the authenticated review surface end to end against real Postgres
 * with RLS: an enrolled learner authors/edits/deletes their single review
 * (each edit re-enters moderation), a course reviewer lists/approves/
 * rejects/removes, and every unauthorised caller (non-enrolled learner,
 * a reviewer of a different course, a plain organization member) is
 * refused with 404 — the guard and the `course_reviews_*` RLS policies
 * agreeing. Body content is sanitised at rest.
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
  seedCourseInstructor,
  seedEnrollment,
  seedOrganizationWithOwner,
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

describe('Course Reviews (e2e)', () => {
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

  /** An academy with an active subscription, an owner member, and one published+public course. */
  async function seedAcademyWithCourse(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label}-course`, {
      status: 'published',
      visibility: 'public',
    });
    return { owner, org, academy, course };
  }

  /** An enrolled, active learner of the given academy+course. */
  async function seedEnrolledLearner(label: string, academyId: string, courseId: string) {
    const learner = await signUpAndSignIn(app, label);
    await seedAcademyStudent(admin, academyId, learner.userId);
    await seedEnrollment(admin, learner.userId, courseId, academyId, {
      status: 'enrolled',
    });
    return learner;
  }

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('an enrolled learner creates a review that lands pending, then reads it back via /mine', async () => {
    const { academy, course } = await seedAcademyWithCourse('rev-create');
    const learner = await seedEnrolledLearner(
      'rev-create-learner',
      academy.id,
      course.id,
    );

    const created = await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(learner.accessToken))
      .send({ rating: 5, body: 'Genuinely useful, well paced.' })
      .expect(201);
    expect(created.body).toMatchObject({
      courseId: course.id,
      studentId: learner.userId,
      rating: 5,
      body: 'Genuinely useful, well paced.',
      status: 'pending',
    });

    const mine = await request(app.getHttpServer())
      .get(`/courses/${course.id}/reviews/mine`)
      .set(auth(learner.accessToken))
      .expect(200);
    expect(mine.body.id).toBe(created.body.id);
    expect(mine.body.status).toBe('pending');
  });

  it('a non-enrolled learner cannot create a review (404)', async () => {
    const { academy, course } = await seedAcademyWithCourse('rev-noenroll');
    // Academy student membership but NO enrollment in the course.
    const outsider = await signUpAndSignIn(app, 'rev-noenroll-outsider');
    await seedAcademyStudent(admin, academy.id, outsider.userId);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(outsider.accessToken))
      .send({ rating: 4 })
      .expect(404);

    // And a completely unrelated user, too.
    const stranger = await signUpAndSignIn(app, 'rev-noenroll-stranger');
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(stranger.accessToken))
      .send({ rating: 4 })
      .expect(404);
  });

  it('re-posting replaces the single review and resets an approved one to pending', async () => {
    const { owner, academy, course } = await seedAcademyWithCourse('rev-replace');
    const learner = await seedEnrolledLearner(
      'rev-replace-learner',
      academy.id,
      course.id,
    );

    const first = await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(learner.accessToken))
      .send({ rating: 3, body: 'first' })
      .expect(201);

    // Owner approves it.
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews/${first.body.id}/approve`)
      .set(auth(owner.accessToken))
      .expect(201);

    // Re-post: same row (unique course+student), back to pending.
    const second = await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(learner.accessToken))
      .send({ rating: 5, body: 'second' })
      .expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.rating).toBe(5);
    expect(second.body.status).toBe('pending');

    // Exactly one row exists for this course+student.
    const rows = await admin.courseReview.count({
      where: { courseId: course.id, studentId: learner.userId },
    });
    expect(rows).toBe(1);
  });

  it('editing via PATCH resets an approved review to pending; DELETE removes it', async () => {
    const { owner, academy, course } = await seedAcademyWithCourse('rev-edit');
    const learner = await seedEnrolledLearner('rev-edit-learner', academy.id, course.id);

    const created = await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(learner.accessToken))
      .send({ rating: 4, body: 'ok' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews/${created.body.id}/approve`)
      .set(auth(owner.accessToken))
      .expect(201);

    const patched = await request(app.getHttpServer())
      .patch(`/courses/${course.id}/reviews/mine`)
      .set(auth(learner.accessToken))
      .send({ rating: 2 })
      .expect(200);
    expect(patched.body.rating).toBe(2);
    expect(patched.body.status).toBe('pending');

    await request(app.getHttpServer())
      .delete(`/courses/${course.id}/reviews/mine`)
      .set(auth(learner.accessToken))
      .expect(204);

    const after = await request(app.getHttpServer())
      .get(`/courses/${course.id}/reviews/mine`)
      .set(auth(learner.accessToken))
      .expect(200);
    expect(after.body).toBeNull();
  });

  it('the course reviewer lists every status and can approve then reject', async () => {
    const { owner, academy, course } = await seedAcademyWithCourse('rev-moderate');
    const l1 = await seedEnrolledLearner('rev-mod-l1', academy.id, course.id);
    const l2 = await seedEnrolledLearner('rev-mod-l2', academy.id, course.id);

    const r1 = await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(l1.accessToken))
      .send({ rating: 5 })
      .expect(201);
    const r2 = await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(l2.accessToken))
      .send({ rating: 2 })
      .expect(201);

    const all = await request(app.getHttpServer())
      .get(`/courses/${course.id}/reviews/moderation`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(all.body.items).toHaveLength(2);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews/${r1.body.id}/approve`)
      .set(auth(owner.accessToken))
      .expect(201)
      .expect((res) => expect(res.body.status).toBe('approved'));

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews/${r2.body.id}/reject`)
      .set(auth(owner.accessToken))
      .expect(201)
      .expect((res) => expect(res.body.status).toBe('rejected'));

    const approvedOnly = await request(app.getHttpServer())
      .get(`/courses/${course.id}/reviews/moderation?status=approved`)
      .set(auth(owner.accessToken))
      .expect(200);
    expect(approvedOnly.body.items).toHaveLength(1);
    expect(approvedOnly.body.items[0].id).toBe(r1.body.id);
  });

  it('the assigned instructor can moderate; a plain learner cannot', async () => {
    const { academy, course } = await seedAcademyWithCourse('rev-instr');
    const learner = await seedEnrolledLearner('rev-instr-learner', academy.id, course.id);
    const review = await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(learner.accessToken))
      .send({ rating: 5 })
      .expect(201);

    // Assigned instructor (course_instructors row) can moderate.
    const instructor = await signUpAndSignIn(app, 'rev-instr-teacher');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');
    await seedCourseInstructor(admin, course.id, instructor.userId);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews/${review.body.id}/approve`)
      .set(auth(instructor.accessToken))
      .expect(201);

    // The enrolled learner is not a reviewer — moderation surface is 404.
    await request(app.getHttpServer())
      .get(`/courses/${course.id}/reviews/moderation`)
      .set(auth(learner.accessToken))
      .expect(404);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews/${review.body.id}/reject`)
      .set(auth(learner.accessToken))
      .expect(404);
  });

  it("a reviewer of one course cannot moderate another course's review (cross-course/academy isolation)", async () => {
    const a = await seedAcademyWithCourse('rev-iso-a');
    const b = await seedAcademyWithCourse('rev-iso-b');
    const learnerA = await seedEnrolledLearner(
      'rev-iso-a-learner',
      a.academy.id,
      a.course.id,
    );
    const reviewA = await request(app.getHttpServer())
      .post(`/courses/${a.course.id}/reviews`)
      .set(auth(learnerA.accessToken))
      .send({ rating: 5 })
      .expect(201);

    // Owner of academy B tries to moderate academy A's review, addressing it
    // through B's own course id and through A's course id — both 404.
    await request(app.getHttpServer())
      .post(`/courses/${b.course.id}/reviews/${reviewA.body.id}/approve`)
      .set(auth(b.owner.accessToken))
      .expect(404);
    await request(app.getHttpServer())
      .post(`/courses/${a.course.id}/reviews/${reviewA.body.id}/approve`)
      .set(auth(b.owner.accessToken))
      .expect(404);

    // The review is untouched (still pending).
    const row = await admin.courseReview.findUniqueOrThrow({
      where: { id: reviewA.body.id },
    });
    expect(row.status).toBe('pending');
  });

  it('sanitises angle brackets out of the stored body', async () => {
    const { academy, course } = await seedAcademyWithCourse('rev-sanitize');
    const learner = await seedEnrolledLearner(
      'rev-sanitize-learner',
      academy.id,
      course.id,
    );

    const created = await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(learner.accessToken))
      .send({ rating: 4, body: 'nice <script>alert(1)</script> course' })
      .expect(201);
    expect(created.body.body).not.toContain('<');
    expect(created.body.body).not.toContain('>');
    expect(created.body.body).toContain('nice');
    expect(created.body.body).toContain('course');
  });

  it('rejects an out-of-range rating (400)', async () => {
    const { academy, course } = await seedAcademyWithCourse('rev-badrating');
    const learner = await seedEnrolledLearner(
      'rev-badrating-learner',
      academy.id,
      course.id,
    );
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(learner.accessToken))
      .send({ rating: 6 })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(learner.accessToken))
      .send({ rating: 0 })
      .expect(400);
  });

  it('requires authentication on every review route (401)', async () => {
    await request(app.getHttpServer()).get('/courses/x/reviews/mine').expect(401);
    await request(app.getHttpServer())
      .post('/courses/x/reviews')
      .send({ rating: 5 })
      .expect(401);
    await request(app.getHttpServer()).get('/courses/x/reviews/moderation').expect(401);
  });

  // -------------------------------------------------------------------
  // Public (approved) surface — anonymous reads through the
  // serving-eligibility-gated public catalog.
  // -------------------------------------------------------------------

  it('exposes only APPROVED reviews publicly and aggregates the rating over them', async () => {
    const { owner, academy, course } = await seedAcademyWithCourse('rev-public');
    const l1 = await seedEnrolledLearner('rev-public-l1', academy.id, course.id);
    const l2 = await seedEnrolledLearner('rev-public-l2', academy.id, course.id);
    const l3 = await seedEnrolledLearner('rev-public-l3', academy.id, course.id);

    const approved1 = await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(l1.accessToken))
      .send({ rating: 4, body: 'solid' })
      .expect(201);
    const approved2 = await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(l2.accessToken))
      .send({ rating: 2, body: 'meh' })
      .expect(201);
    // l3's review stays pending (never moderated).
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(l3.accessToken))
      .send({ rating: 5, body: 'should not count' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews/${approved1.body.id}/approve`)
      .set(auth(owner.accessToken))
      .expect(201);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews/${approved2.body.id}/approve`)
      .set(auth(owner.accessToken))
      .expect(201);

    // Public list (no auth): only the two approved reviews, not the pending one.
    const publicList = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${course.id}/reviews`)
      .expect(200);
    expect(publicList.body.items).toHaveLength(2);
    const ids = publicList.body.items.map((r: { id: string }) => r.id).sort();
    expect(ids).toEqual([approved1.body.id, approved2.body.id].sort());
    expect(
      publicList.body.items.every((r: { status: string }) => r.status === 'approved'),
    ).toBe(true);

    // Rating aggregate: mean of 4 and 2 = 3.0 over 2 approved reviews.
    const rating = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${course.id}/rating`)
      .expect(200);
    expect(rating.body).toMatchObject({
      courseId: course.id,
      averageRating: 3,
      totalReviews: 2,
    });
    expect(rating.body.distribution['4']).toBe(1);
    expect(rating.body.distribution['2']).toBe(1);
    expect(rating.body.distribution['5']).toBe(0);
  });

  it('a course with no approved reviews returns a zeroed public rating (visible, not null)', async () => {
    const { academy, course } = await seedAcademyWithCourse('rev-public-zero');
    const learner = await seedEnrolledLearner('rev-public-zero-l', academy.id, course.id);
    // A pending review must not move the public number.
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/reviews`)
      .set(auth(learner.accessToken))
      .send({ rating: 5 })
      .expect(201);

    const rating = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${course.id}/rating`)
      .expect(200);
    expect(rating.body).toMatchObject({ averageRating: 0, totalReviews: 0 });

    const list = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${course.id}/reviews`)
      .expect(200);
    expect(list.body.items).toHaveLength(0);
  });

  it('a draft/private course is not publicly visible for reviews or rating (404)', async () => {
    const { academy } = await seedAcademyWithCourse('rev-public-hidden');
    const draft = await seedCourse(admin, academy.id, 'rev-hidden-draft', {
      status: 'draft',
      visibility: 'public',
    });
    const priv = await seedCourse(admin, academy.id, 'rev-hidden-private', {
      status: 'published',
      visibility: 'private',
    });

    for (const c of [draft, priv]) {
      await request(app.getHttpServer())
        .get(`/public/websites/${academy.id}/courses/${c.id}/reviews`)
        .expect(404);
      await request(app.getHttpServer())
        .get(`/public/websites/${academy.id}/courses/${c.id}/rating`)
        .expect(404);
    }
  });
});
