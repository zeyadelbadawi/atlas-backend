/**
 * Course Forum e2e suite (master plan §21 Phase P7, §5.5, §10). Exercises
 * `ForumsController`'s real `courses/:id/forum/*` HTTP surface, matching
 * `ForumService`'s (frontend) contract exactly — get-or-create, threads,
 * replies, and moderation (pin/unpin/lock/unlock).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseInstructor,
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

describe('Course Forum (e2e)', () => {
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

  async function seedCourseWithParticipants(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const instructor = await signUpAndSignIn(app, `${label}-instr`);
    const student = await signUpAndSignIn(app, `${label}-student`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label}-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
    });
    await seedCourseInstructor(admin, course.id, instructor.userId);
    await seedAcademyStudent(admin, academy.id, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ courseId: course.id })
      .expect(201);
    return { owner, instructor, student, course };
  }

  it('a course forum is get-or-created lazily; an enrolled student can start a thread and reply, and reply/thread counts are real', async () => {
    const { student, course } = await seedCourseWithParticipants('forum-basic');

    const forum = await request(app.getHttpServer())
      .get(`/courses/${course.id}/forum`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(forum.body.courseId).toBe(course.id);
    expect(forum.body.threadCount).toBe(0);

    const thread = await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ title: 'Question about lesson 1', body: 'Can someone help?' })
      .expect(201);
    expect(thread.body.replyCount).toBe(0);

    const reply = await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads/${thread.body.id}/replies`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ body: 'Sure, here is an answer.' })
      .expect(201);
    expect(reply.body.authorName).toBeTruthy();

    const threadDetail = await request(app.getHttpServer())
      .get(`/courses/${course.id}/forum/threads/${thread.body.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(threadDetail.body.replyCount).toBe(1);

    const forumAfter = await request(app.getHttpServer())
      .get(`/courses/${course.id}/forum`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(forumAfter.body.threadCount).toBe(1);
  });

  it('B6 V04 — a thread or reply of only spaces is refused on its field, not saved blank', async () => {
    const { student, course } = await seedCourseWithParticipants('forum-blank');

    const blankThread = await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ title: '   ', body: '  \n ' })
      .expect(400);
    const fields = blankThread.body.violations.map((v: { field: string }) => v.field);
    expect(fields).toEqual(expect.arrayContaining(['title', 'body']));

    const thread = await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ title: '  Trimmed title  ', body: 'Real body' })
      .expect(201);
    expect(thread.body.title).toBe('Trimmed title');

    const blankReply = await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads/${thread.body.id}/replies`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ body: '   ' })
      .expect(400);
    expect(blankReply.body.violations[0].field).toBe('body');

    const detail = await request(app.getHttpServer())
      .get(`/courses/${course.id}/forum/threads/${thread.body.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(200);
    expect(detail.body.replyCount).toBe(0);
  });

  it('someone with no real relationship to the course cannot see or post to its forum', async () => {
    const { course } = await seedCourseWithParticipants('forum-denied');
    const outsider = await signUpAndSignIn(app, 'forum-denied-outsider');

    await request(app.getHttpServer())
      .get(`/courses/${course.id}/forum`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads`)
      .set('Authorization', `Bearer ${outsider.accessToken}`)
      .send({ title: 'Sneaking in', body: 'x' })
      .expect(404);
  });

  it('the real course instructor can pin and lock a thread; a plain enrolled student cannot', async () => {
    const { instructor, student, course } =
      await seedCourseWithParticipants('forum-moderate');

    const thread = await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ title: 'Off topic', body: 'x' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads/${thread.body.id}/pin`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(403);

    const pinned = await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads/${thread.body.id}/pin`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(201);
    expect(pinned.body.pinned).toBe(true);

    const locked = await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads/${thread.body.id}/lock`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(201);
    expect(locked.body.locked).toBe(true);
  });

  it('B6 V05 — a moderator can delete a reply and a thread; a student cannot', async () => {
    const { instructor, student, course } =
      await seedCourseWithParticipants('forum-delete');
    const server = app.getHttpServer();

    const thread = await request(server)
      .post(`/courses/${course.id}/forum/threads`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ title: 'To be removed', body: 'x' })
      .expect(201);
    const reply = await request(server)
      .post(`/courses/${course.id}/forum/threads/${thread.body.id}/replies`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ body: 'Abusive reply' })
      .expect(201);

    // The author is a plain participant: not allowed, even on their own post.
    await request(server)
      .delete(
        `/courses/${course.id}/forum/threads/${thread.body.id}/replies/${reply.body.id}`,
      )
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(403);
    await request(server)
      .delete(`/courses/${course.id}/forum/threads/${thread.body.id}`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(403);

    await request(server)
      .delete(
        `/courses/${course.id}/forum/threads/${thread.body.id}/replies/${reply.body.id}`,
      )
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(204);
    const afterReply = await request(server)
      .get(`/courses/${course.id}/forum/threads/${thread.body.id}`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(200);
    expect(afterReply.body.replyCount).toBe(0);

    // Deleting it again, or a reply id from nowhere: 404, not a silent 204.
    await request(server)
      .delete(
        `/courses/${course.id}/forum/threads/${thread.body.id}/replies/${reply.body.id}`,
      )
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(404);

    await request(server)
      .delete(`/courses/${course.id}/forum/threads/${thread.body.id}`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(204);
    await request(server)
      .get(`/courses/${course.id}/forum/threads/${thread.body.id}`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(404);
  });

  it('replying to a locked thread is rejected', async () => {
    const { instructor, student, course } =
      await seedCourseWithParticipants('forum-locked');

    const thread = await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ title: 'Will be locked', body: 'x' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads/${thread.body.id}/lock`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(201);

    await request(app.getHttpServer())
      .post(`/courses/${course.id}/forum/threads/${thread.body.id}/replies`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .send({ body: 'Too late?' })
      .expect(403);
  });
});
