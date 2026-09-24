/**
 * P64 Phase 4 — the public course preview (the free sample a prospective
 * student watches before buying).
 *
 * The backend already served this: `LessonContentService.getContent()` has
 * an `isOpenPreview` short-circuit (`lesson.isPreview` + lesson published +
 * course published) that skips identity, enrolment and suspension, and its
 * route sits behind `OptionalJwtAuthGuard`, so an anonymous visitor could
 * always fetch a preview lesson's content. What was missing is that the
 * PUBLIC curriculum never projected `isPreview`, so nothing on the
 * marketing page could tell a visitor which lesson that was.
 *
 * These cases pin the AGREEMENT between the two halves: the flag the
 * curriculum publishes is exactly the flag the content gate honours. A
 * lesson advertised as previewable plays for an anonymous visitor, and one
 * that is not is refused — including the case that matters most, a lesson
 * flagged `isPreview` whose course or lesson is not published.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { uniqueTestEmail } from './utils/test-app';
import type { PrismaClient } from '@prisma/client';

/** A real YouTube id shape — `classifyExternalEmbed` validates the alphabet. */
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const YOUTUBE_ID = 'dQw4w9WgXcQ';

describe('P64 Phase 4 — public course preview (e2e)', () => {
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

  async function arrange(
    label: string,
    opts: {
      courseStatus?: 'draft' | 'published';
      previewLessonStatus?: 'draft' | 'published';
    } = {},
  ) {
    const ownerEmail = uniqueTestEmail(`${label}-owner`);
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: `${label}-owner`, email: ownerEmail, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: ownerEmail, password })
      .expect(200);

    const org = await seedOrganizationWithOwner(
      admin,
      signIn.body.user.id,
      `${label}-org`,
    );
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label}-course`, {
      status: opts.courseStatus ?? 'published',
      visibility: 'public',
    });
    const section = await seedCourseSection(admin, course.id, `${label}-section`, 1);

    const previewLesson = await seedCourseLesson(
      admin,
      section.id,
      course.id,
      `${label}-preview-lesson`,
      1,
      { status: opts.previewLessonStatus ?? 'published' },
    );
    await admin.courseLesson.update({
      where: { id: previewLesson.id },
      data: { isPreview: true },
    });
    await admin.lessonContent.create({
      data: {
        lessonId: previewLesson.id,
        courseId: course.id,
        academyId: academy.id,
        kind: 'external',
        externalUrl: YOUTUBE_URL,
      },
    });

    const gatedLesson = await seedCourseLesson(
      admin,
      section.id,
      course.id,
      `${label}-gated-lesson`,
      2,
      { status: 'published' },
    );
    await admin.lessonContent.create({
      data: {
        lessonId: gatedLesson.id,
        courseId: course.id,
        academyId: academy.id,
        kind: 'external',
        externalUrl: YOUTUBE_URL,
      },
    });

    return { academy, course, previewLesson, gatedLesson };
  }

  it('the public curriculum marks the preview lesson and only that lesson', async () => {
    const { academy, course, previewLesson, gatedLesson } = await arrange('prev-flag');

    const res = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${course.id}/curriculum`)
      .expect(200);

    const lessons = res.body.flatMap(
      (s: { lessons: { id: string; isPreview: boolean }[] }) => s.lessons,
    );
    const preview = lessons.find((l: { id: string }) => l.id === previewLesson.id);
    const gated = lessons.find((l: { id: string }) => l.id === gatedLesson.id);
    expect(preview?.isPreview).toBe(true);
    expect(gated?.isPreview).toBe(false);
  });

  it('an anonymous visitor can play the lesson the curriculum advertises as a preview', async () => {
    const { course, previewLesson } = await arrange('prev-play');

    const res = await request(app.getHttpServer())
      .get(`/learning/courses/${course.id}/lessons/${previewLesson.id}/content`)
      .expect(200);

    expect(res.body.isPreview).toBe(true);
    expect(res.body.kind).toBe('external');
    expect(res.body.externalEmbed).toEqual({ provider: 'youtube', videoId: YOUTUBE_ID });
    // No session means nothing to lease — the contract says so explicitly.
    expect(res.body.playbackLease).toBeNull();
    // Honest about what protects an embed Atlas does not host.
    expect(res.body.protection.signedUrl).toBe(false);
    expect(res.body.protection.drm).toBe(false);
  });

  it('an anonymous visitor is refused the lesson the curriculum does NOT advertise', async () => {
    const { course, gatedLesson } = await arrange('prev-gated');

    const res = await request(app.getHttpServer()).get(
      `/learning/courses/${course.id}/lessons/${gatedLesson.id}/content`,
    );
    // 404, not 401/403, and that is the point: `refusalToHttp` keeps
    // unreachable content indistinguishable from content that does not
    // exist, so publishing the preview flag cannot be turned into an
    // oracle for enumerating the lesson ids of a paid catalogue.
    expect(res.status).toBe(404);
  });

  it('a preview flag on an unpublished lesson advertises nothing and opens nothing', async () => {
    const { academy, course, previewLesson } = await arrange('prev-draftlesson', {
      previewLessonStatus: 'draft',
    });

    const curriculum = await request(app.getHttpServer())
      .get(`/public/websites/${academy.id}/courses/${course.id}/curriculum`)
      .expect(200);
    const ids = curriculum.body.flatMap((s: { lessons: { id: string }[] }) =>
      s.lessons.map((l) => l.id),
    );
    expect(ids).not.toContain(previewLesson.id);

    const grant = await request(app.getHttpServer()).get(
      `/learning/courses/${course.id}/lessons/${previewLesson.id}/content`,
    );
    expect([401, 403, 404]).toContain(grant.status);
  });

  it('a preview flag inside an unpublished course opens nothing', async () => {
    const { course, previewLesson } = await arrange('prev-draftcourse', {
      courseStatus: 'draft',
    });

    const grant = await request(app.getHttpServer()).get(
      `/learning/courses/${course.id}/lessons/${previewLesson.id}/content`,
    );
    expect([401, 403, 404]).toContain(grant.status);
  });
});
