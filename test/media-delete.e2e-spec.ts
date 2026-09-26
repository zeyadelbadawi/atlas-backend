/**
 * Media delete (archive → purge after 30 days) — authorization matrix,
 * usage guard and lifecycle, against real Postgres as `atlas_app`.
 *
 *                   single   bulk
 *   Client Owner      YES     YES
 *   Manager           YES     YES
 *   Instructor         NO      NO
 *   Learner            NO      NO
 *   Platform Owner     NO      NO
 *   + manager of ANOTHER academy, another organization, anonymous → refused.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { ArchivedMediaPurgeService } from '../src/retention/services/archived-media-purge.service';
import type { PrismaClient } from '@prisma/client';

describe('Media delete — authorization, usage guard, lifecycle (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  beforeEach(async () => flush());

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function signIn(label: string) {
    const email = uniqueTestEmail(label);
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    return { userId: res.body.user.id as string, token: res.body.accessToken as string };
  }

  async function world(label: string) {
    const owner = await signIn(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const sibling = await seedAcademy(admin, org.id, `${label}-sibling`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const manager = await signIn(`${label}-manager`);
    await seedMembership(admin, org.id, manager.userId, 'manager');
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');
    const siblingManager = await signIn(`${label}-sib-manager`);
    await seedMembership(admin, org.id, siblingManager.userId, 'manager');
    await seedAcademyMember(admin, sibling.id, siblingManager.userId, 'manager');
    const instructor = await signIn(`${label}-instructor`);
    await seedMembership(admin, org.id, instructor.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');
    const learner = await signIn(`${label}-learner`);
    await seedAcademyStudent(admin, academy.id, learner.userId);
    return { owner, org, academy, manager, siblingManager, instructor, learner };
  }

  async function asset(academyId: string) {
    const id = randomUUID();
    return admin.mediaAsset.create({
      data: {
        id,
        academyId,
        type: 'image',
        status: 'active',
        fileName: `${id}.png`,
        storageKey: `academies/${academyId}/${id}.png`,
        url: `http://localhost:9000/atlas-media-ci/academies/${academyId}/${id}.png`,
        mimeType: 'image/png',
        sizeBytes: BigInt(10),
        access: 'public',
        provider: 'r2',
      },
    });
  }

  const del = (academyId: string, assetId: string, token?: string) => {
    const req = request(app.getHttpServer()).post(
      `/academies/${academyId}/media/${assetId}/archive`,
    );
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const bulk = (academyId: string, assetIds: string[], token: string) =>
    request(app.getHttpServer())
      .post(`/academies/${academyId}/media/archive-batch`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assetIds });
  const status = async (id: string) =>
    (await admin.mediaAsset.findUniqueOrThrow({ where: { id } })).status;

  it('Client Owner and Manager can delete, singly and in bulk', async () => {
    const w = await world('md-allowed');
    const a = await asset(w.academy.id);
    const b = await asset(w.academy.id);
    const c = await asset(w.academy.id);
    await del(w.academy.id, a.id, w.owner.token).expect(201);
    await del(w.academy.id, b.id, w.manager.token).expect(201);
    expect(await status(a.id)).toBe('archived');
    expect(await status(b.id)).toBe('archived');

    const res = await bulk(w.academy.id, [c.id], w.manager.token).expect(200);
    expect(res.body.archived).toEqual([c.id]);
    expect(await status(c.id)).toBe('archived');

    // Idempotent: deleting again is harmless.
    await del(w.academy.id, a.id, w.owner.token).expect(201);
  });

  it('Instructor, Learner and Platform Owner cannot delete, singly or in bulk', async () => {
    const w = await world('md-refused');
    const a = await asset(w.academy.id);
    const po = await signIn('md-po');
    await admin.user.update({
      where: { id: po.userId },
      data: { isPlatformOwner: true },
    });
    for (const caller of [w.instructor, w.learner, po]) {
      await del(w.academy.id, a.id, caller.token).expect(403);
      await bulk(w.academy.id, [a.id], caller.token).expect(403);
    }
    expect(await status(a.id)).toBe('active');
  });

  it('refuses anonymous, sibling-academy manager and cross-organization callers', async () => {
    const w = await world('md-scope');
    const other = await world('md-scope-other');
    const a = await asset(w.academy.id);
    await del(w.academy.id, a.id).expect(401);
    await del(w.academy.id, a.id, w.siblingManager.token).expect(403);
    await bulk(w.academy.id, [a.id], w.siblingManager.token).expect(403);
    await del(w.academy.id, a.id, other.owner.token).expect(403);
    // Using one's OWN academy route with another academy's asset id finds nothing.
    await del(other.academy.id, a.id, other.owner.token).expect(404);
    const res = await bulk(other.academy.id, [a.id], other.owner.token).expect(200);
    expect(res.body.refused).toEqual([{ id: a.id, reason: 'notFound', usages: [] }]);
    expect(await status(a.id)).toBe('active');
  });

  it('refuses media still in use and names the usage; bulk reports mixed outcomes', async () => {
    const w = await world('md-in-use');
    const used = await asset(w.academy.id);
    const logo = await asset(w.academy.id);
    const free = await asset(w.academy.id);
    const course = await seedCourse(admin, w.academy.id, 'md-course');
    const section = await seedCourseSection(admin, course.id, 'md-section', 1);
    const lesson = await seedCourseLesson(admin, section.id, course.id, 'md-lesson', 1);
    await admin.courseLesson.update({
      where: { id: lesson.id },
      data: { videoAssetId: used.id },
    });
    await admin.academy.update({
      where: { id: w.academy.id },
      data: { logoUrl: logo.url },
    });

    const single = await del(w.academy.id, used.id, w.owner.token).expect(409);
    expect(single.body.error.messageKey).toBe('errors.media.inUse');
    expect(single.body.error.details.usages).toEqual([{ kind: 'lessonVideo', count: 1 }]);

    const res = await bulk(
      w.academy.id,
      [used.id, logo.id, free.id],
      w.manager.token,
    ).expect(200);
    expect(res.body.archived).toEqual([free.id]);
    expect(res.body.refused).toEqual(
      expect.arrayContaining([
        { id: used.id, reason: 'inUse', usages: [{ kind: 'lessonVideo', count: 1 }] },
        { id: logo.id, reason: 'inUse', usages: [{ kind: 'academyLogo', count: 1 }] },
      ]),
    );
    expect(await status(used.id)).toBe('active');
    expect(await status(logo.id)).toBe('active');
    expect(await status(free.id)).toBe('archived');
  });

  it('a just-deleted asset is inside the 30-day grace — the purge will not destroy it yet', async () => {
    const w = await world('md-grace');
    const a = await asset(w.academy.id);
    await del(w.academy.id, a.id, w.owner.token).expect(201);
    const purge = app.get(ArchivedMediaPurgeService);
    const spy = jest.spyOn(purge, 'mode', 'get').mockReturnValue('on');
    try {
      expect(await purge.purgeAsset({ assetId: a.id, organizationId: w.org.id })).toBe(
        'not_eligible',
      );
    } finally {
      spy.mockRestore();
    }
    expect(await status(a.id)).toBe('archived');
  });
});
