/**
 * D5-4 (B0-MED-05 residual) — the staff Media Library and protected files.
 *
 * The library list derived every asset's `url` from its storage key, so a
 * protected lesson file came back as `/api/v1/public/media/academies/…` — a
 * public-looking address for an object that lives in the separate protected
 * bucket. That address never served the file (the public route refuses a
 * protected row, and the bytes are not in the public bucket), but staff saw
 * it as an ordinary link. Pinned here:
 *
 *   MPL-01  the list (and detail) report `url: null` + `protected: true` for
 *           a protected asset; a legacy public asset is unchanged
 *   MPL-02  nothing the API returns for a protected asset can be fetched
 *           anonymously: the formerly derived public path is a 404, and the
 *           grant route refuses a caller with no token
 *   MPL-03  staff preview/download is a short-lived presigned GET on the
 *           protected bucket (the learner grant's delivery), for the managing
 *           tier only — an instructor or staff member is refused
 *   MPL-04  tenancy: another organization's owner and a sibling academy's
 *           manager get nothing, by academy path or by guessed asset id
 *   MPL-05  only a protected, stored, unpurged FILE is granted: a public
 *           asset and a purged one are 404, a provider-hosted video is 400
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';

jest.setTimeout(120000);

const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
);
const PDF_DATA_URL = `data:application/pdf;base64,${PDF_BYTES.toString('base64')}`;

describe('D5-4 protected files in the staff Media Library (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;

  const http = () => request(app.getHttpServer());

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
    const password = 'correct-horse-battery-mpl';
    await http()
      .post('/auth/register')
      .send({ name: label, email, password })
      .expect(201);
    const res = await http().post('/auth/sign-in').send({ email, password }).expect(200);
    return { userId: res.body.user.id as string, token: res.body.accessToken as string };
  }

  async function world(label: string) {
    const owner = await signIn(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const sibling = await seedAcademy(admin, org.id, `${label}-sibling`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label}-course`);

    const staff = async (role: 'manager' | 'instructor' | 'staff', academyId: string) => {
      const user = await signIn(`${label}-${role}`);
      await seedMembership(admin, org.id, user.userId, role);
      await seedAcademyMember(admin, academyId, user.userId, role);
      return user;
    };
    const manager = await staff('manager', academy.id);
    const instructor = await staff('instructor', academy.id);
    const staffMember = await staff('staff', academy.id);
    const siblingManager = await staff('manager', sibling.id);
    return {
      owner,
      org,
      academy,
      sibling,
      course,
      manager,
      instructor,
      staffMember,
      siblingManager,
    };
  }

  async function uploadProtected(
    academyId: string,
    token: string,
    courseId?: string,
  ): Promise<{ id: string }> {
    const res = await http()
      .post(`/academies/${academyId}/media/protected`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        fileName: 'worksheet.pdf',
        file: PDF_DATA_URL,
        ...(courseId ? { courseId } : {}),
      })
      .expect(201);
    return res.body as { id: string };
  }

  const grant = (academyId: string, assetId: string, token?: string) => {
    const req = http().post(`/academies/${academyId}/media/${assetId}/grant`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('MPL-01 — the list and detail report no URL for a protected asset; a public asset is unchanged', async () => {
    const w = await world('mpl-list');
    const loose = await uploadProtected(w.academy.id, w.owner.token);
    const forCourse = await uploadProtected(w.academy.id, w.owner.token, w.course.id);
    const publicAsset = await admin.mediaAsset.create({
      data: {
        academyId: w.academy.id,
        type: 'image',
        fileName: 'logo.png',
        storageKey: `academies/${w.academy.id}/${randomUUID()}.png`,
        url: '',
        mimeType: 'image/png',
        sizeBytes: BigInt(10),
      },
    });

    const list = await http()
      .get(`/academies/${w.academy.id}/media?pageSize=100`)
      .set('Authorization', `Bearer ${w.manager.token}`)
      .expect(200);
    const byId = new Map<string, Record<string, unknown>>(
      list.body.items.map((item: Record<string, unknown>) => [item.id as string, item]),
    );

    for (const id of [loose.id, forCourse.id]) {
      const row = byId.get(id)!;
      expect(row).toMatchObject({ access: 'protected', protected: true, url: null });
      // No public-route path and no storage key anywhere in the row.
      const stored = await admin.mediaAsset.findUniqueOrThrow({ where: { id } });
      expect(JSON.stringify(row)).not.toContain('/public/media');
      expect(JSON.stringify(row)).not.toContain(stored.storageKey);
    }
    expect(byId.get(publicAsset.id)).toMatchObject({
      access: 'public',
      protected: false,
      url: `/api/v1/public/media/${publicAsset.storageKey}`,
    });

    // The instructor's read of the same list is the same shape.
    const instructorList = await http()
      .get(`/academies/${w.academy.id}/media?access=protected`)
      .set('Authorization', `Bearer ${w.instructor.token}`)
      .expect(200);
    for (const item of instructorList.body.items as Record<string, unknown>[]) {
      expect(item.url).toBeNull();
      expect(item.protected).toBe(true);
    }

    const detail = await http()
      .get(`/academies/${w.academy.id}/media/${loose.id}`)
      .set('Authorization', `Bearer ${w.owner.token}`)
      .expect(200);
    expect(detail.body).toMatchObject({ protected: true, url: null });
  });

  it('MPL-02 — nothing returned for a protected asset is fetchable without authorization', async () => {
    const w = await world('mpl-anon');
    const loose = await uploadProtected(w.academy.id, w.owner.token);
    const forCourse = await uploadProtected(w.academy.id, w.owner.token, w.course.id);

    // What the old contract handed out for these rows: the public route
    // refuses both (one matches the route and is refused by its row, the
    // other — with a course segment — matches no route at all).
    for (const id of [loose.id, forCourse.id]) {
      const stored = await admin.mediaAsset.findUniqueOrThrow({ where: { id } });
      await http().get(`/public/media/${stored.storageKey}`).expect(404);
    }

    // The grant itself needs a signed-in staff member.
    await grant(w.academy.id, loose.id).expect(401);
  });

  it('MPL-03 — owner and manager get a short-lived presigned link; instructor and staff are refused', async () => {
    const w = await world('mpl-grant');
    const file = await uploadProtected(w.academy.id, w.owner.token, w.course.id);

    for (const caller of [w.owner, w.manager]) {
      const res = await grant(w.academy.id, file.id, caller.token).expect(200);
      const url = new URL(res.body.url as string);
      // A presign on the PROTECTED bucket — not a path on the public route.
      expect(url.pathname).toContain('-protected/');
      expect(url.pathname).not.toContain('/public/media');
      expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
      expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(600);
      const expiresIn = new Date(res.body.expiresAt as string).getTime() - Date.now();
      expect(expiresIn).toBeGreaterThan(0);
      expect(expiresIn).toBeLessThanOrEqual(600 * 1000);
      expect(res.headers['cache-control']).toBe('private, no-store');

      // It really delivers the file.
      const fetched = await fetch(url);
      expect(fetched.status).toBe(200);
      expect(Buffer.compare(Buffer.from(await fetched.arrayBuffer()), PDF_BYTES)).toBe(0);
    }

    for (const caller of [w.instructor, w.staffMember]) {
      const refused = await grant(w.academy.id, file.id, caller.token).expect(403);
      expect(refused.body.error.messageKey).toBe('errors.academy.insufficientRole');
    }
  });

  it('MPL-04 — another organization and a sibling academy cannot obtain a grant', async () => {
    const w = await world('mpl-tenant');
    const file = await uploadProtected(w.academy.id, w.owner.token);
    const other = await world('mpl-tenant-other');

    // Through the victim academy's path: refused at the academy boundary.
    await grant(w.academy.id, file.id, other.owner.token).expect(403);
    await grant(w.academy.id, file.id, w.siblingManager.token).expect(403);

    // Through their OWN academy's path with the guessed asset id: not found.
    await grant(other.academy.id, file.id, other.owner.token).expect(404);
    await grant(w.sibling.id, file.id, w.siblingManager.token).expect(404);
    // The organization owner addressing the sibling academy still cannot
    // pull this academy's asset through it.
    await grant(w.sibling.id, file.id, w.owner.token).expect(404);
  });

  it('MPL-05 — public, purged and provider-hosted assets get no file grant', async () => {
    const w = await world('mpl-kinds');
    const publicAsset = await admin.mediaAsset.create({
      data: {
        academyId: w.academy.id,
        type: 'document',
        fileName: 'public.pdf',
        storageKey: `academies/${w.academy.id}/${randomUUID()}.pdf`,
        url: '',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(10),
      },
    });
    await grant(w.academy.id, publicAsset.id, w.owner.token).expect(404);

    const purged = await uploadProtected(w.academy.id, w.owner.token);
    await admin.mediaAsset.update({
      where: { id: purged.id },
      data: { deletedAt: new Date() },
    });
    await grant(w.academy.id, purged.id, w.owner.token).expect(404);

    const hostedVideo = await admin.mediaAsset.create({
      data: {
        academyId: w.academy.id,
        type: 'video',
        fileName: 'lecture.mp4',
        storageKey: '',
        url: '',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(0),
        access: 'protected',
        provider: 'r2_worker',
        providerId: `academies/${w.academy.id}/${randomUUID()}.mp4`,
        processingStatus: 'ready',
      },
    });
    const refused = await grant(w.academy.id, hostedVideo.id, w.owner.token).expect(400);
    expect(refused.body.error.messageKey).toBe('errors.media.previewUnavailable');

    await grant(w.academy.id, randomUUID(), w.owner.token).expect(404);
  });
});
