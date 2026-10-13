/**
 * B0-MED-11 — what the course builder needs to attach an Atlas-hosted video
 * to a Video lesson, on top of the existing upload / completion / grant
 * paths (covered by p64-phase2-api and forensic-watermark).
 *
 *   HVA-01  only this academy's PROTECTED video whose upload finished can be
 *           attached: a public library video is refused (it would bypass the
 *           grant and the watermark), a pending or failed upload is refused,
 *           a processing or ready one is accepted
 *   HVA-02  the authoring lesson response carries `videoAssetId`, and
 *           `null` detaches
 *   HVA-03  a `video` content row refuses a public asset too
 *   HVA-04  the media list can be narrowed to protected assets and reports
 *           access, processing state and duration
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedOrganizationWithOwner,
} from './utils/db-admin';

jest.setTimeout(120000);

describe('B0-MED-11 hosted video authoring (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let token: string;
  let academyId: string;
  let courseId: string;
  let sectionId: string;

  const http = () => request(app.getHttpServer());
  const lessonsPath = () =>
    `/academies/${academyId}/courses/${courseId}/sections/${sectionId}/lessons`;

  async function videoAsset(
    access: 'public' | 'protected',
    processingStatus: 'pending' | 'processing' | 'ready' | 'failed',
    targetAcademy = academyId,
  ) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return admin.mediaAsset.create({
      data: {
        academyId: targetAcademy,
        type: 'video',
        fileName: `hva-${access}-${processingStatus}-${suffix}.mp4`,
        storageKey: access === 'public' ? `academies/${targetAcademy}/${suffix}.mp4` : '',
        url: access === 'public' ? `https://storage.test.local/${suffix}.mp4` : '',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(4096),
        access,
        provider: access === 'protected' ? 'r2_worker' : 'r2',
        processingStatus,
        durationSeconds: 90,
      },
    });
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    await flush();

    const email = uniqueTestEmail('hva-owner');
    const password = 'correct-horse-battery-hva';
    await http()
      .post('/auth/register')
      .send({ name: 'hva', email, password })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    token = signIn.body.accessToken;
    const userId = signIn.body.user.id as string;
    const org = await seedOrganizationWithOwner(admin, userId, 'hva-org');
    const academy = await seedAcademy(admin, org.id, 'hva-academy');
    await seedAcademyMember(admin, academy.id, userId, 'owner');
    academyId = academy.id;
    const course = await seedCourse(admin, academyId, 'hva-course');
    courseId = course.id;
    sectionId = (await seedCourseSection(admin, courseId, 'Unit', 0)).id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const create = (videoAssetId: string) =>
    http()
      .post(lessonsPath())
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Hosted', contentType: 'video', videoAssetId });

  it('HVA-01 — attaches only a protected video whose upload finished', async () => {
    const publicVideo = await videoAsset('public', 'ready');
    const refusedPublic = await create(publicVideo.id).expect(400);
    expect(refusedPublic.body.error.messageKey).toBe('errors.media.videoNotAttachable');

    for (const status of ['pending', 'failed'] as const) {
      const asset = await videoAsset('protected', status);
      const refused = await create(asset.id).expect(409);
      expect(refused.body.error.messageKey).toBe('errors.media.videoNotReady');
    }

    const otherOrgOwner = await admin.organization.findFirstOrThrow({
      where: { academies: { some: { id: academyId } } },
      select: { ownerUserId: true },
    });
    const otherOrg = await seedOrganizationWithOwner(
      admin,
      otherOrgOwner.ownerUserId!,
      'hva-other-org',
    );
    const otherAcademy = await seedAcademy(admin, otherOrg.id, 'hva-other');
    const foreign = await videoAsset('protected', 'ready', otherAcademy.id);
    await create(foreign.id).expect(404);

    expect(await admin.courseLesson.count({ where: { sectionId } })).toBe(0);

    for (const status of ['processing', 'ready'] as const) {
      const asset = await videoAsset('protected', status);
      const created = await create(asset.id).expect(201);
      expect(created.body.videoAssetId).toBe(asset.id);
    }
  });

  it('HVA-02 — the lesson response carries videoAssetId and null detaches', async () => {
    const asset = await videoAsset('protected', 'ready');
    const lesson = await seedCourseLesson(admin, sectionId, courseId, 'hva-edit', 50, {
      contentType: 'video',
    });
    const attached = await http()
      .patch(`${lessonsPath()}/${lesson.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ videoAssetId: asset.id })
      .expect(200);
    expect(attached.body.videoAssetId).toBe(asset.id);

    const publicVideo = await videoAsset('public', 'ready');
    await http()
      .patch(`${lessonsPath()}/${lesson.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ videoAssetId: publicVideo.id })
      .expect(400);

    const detached = await http()
      .patch(`${lessonsPath()}/${lesson.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ videoAssetId: null })
      .expect(200);
    expect(detached.body.videoAssetId).toBeNull();
  });

  it('HVA-03 — a video content row refuses a public asset', async () => {
    const lesson = await seedCourseLesson(admin, sectionId, courseId, 'hva-content', 60, {
      contentType: 'video',
    });
    const publicVideo = await videoAsset('public', 'ready');
    const refused = await http()
      .put(`${lessonsPath()}/${lesson.id}/content`)
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'video', mediaAssetId: publicVideo.id });
    expect(refused.status).toBe(400);
    expect(refused.body.error.messageKey).toBe('errors.lessonContent.assetNotProtected');
  });

  it('HVA-04 — the media list narrows to protected assets with their state', async () => {
    const ready = await videoAsset('protected', 'ready');
    const publicVideo = await videoAsset('public', 'ready');
    const res = await http()
      .get(`/academies/${academyId}/media?type=video&access=protected&pageSize=100`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ids = res.body.items.map((item: { id: string }) => item.id);
    expect(ids).toContain(ready.id);
    expect(ids).not.toContain(publicVideo.id);
    const item = res.body.items.find((entry: { id: string }) => entry.id === ready.id);
    expect(item).toMatchObject({
      access: 'protected',
      processingStatus: 'ready',
      durationSeconds: 90,
    });
    await http()
      .get(`/academies/${academyId}/media?access=secret`)
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });
});
