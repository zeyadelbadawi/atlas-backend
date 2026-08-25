/**
 * CMS Content Library tenant-isolation suite — P10-TENANT-001..006
 * (master plan §18/§21 Phase P10), extending the permanent
 * tenant-isolation suite established in `tenant-isolation.e2e-spec.ts`
 * (P2) through `website-tenant-isolation.e2e-spec.ts` (P9) — one file per
 * phase, same pattern. Exercised through the real HTTP surface; the pure
 * DB-level RLS proof lives in `rls-website-content.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
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

describe('CMS Content Library tenant isolation (e2e) — P10-TENANT-001..006', () => {
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

  async function seedManagedAcademy(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { owner, academy };
  }

  it("P10-TENANT-001: Organization B cannot read Organization A's FAQ entry by direct id", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t10-001-a');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ question: { en: 'Q', ar: 'س' }, answer: { en: 'A', ar: 'ج' } })
      .expect(201);

    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('t10-001-b');

    await request(app.getHttpServer())
      .get(`/academies/${academyB.id}/website/faq-entries/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);

    await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(403);
  });

  it("P10-TENANT-002: Organization B cannot read Organization A's Testimonial entry by direct id", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t10-002-a');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/testimonial-entries`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ quote: { en: 'Q', ar: 'س' }, authorName: 'Jane' })
      .expect(201);

    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('t10-002-b');

    await request(app.getHttpServer())
      .get(`/academies/${academyB.id}/website/testimonial-entries/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);
  });

  it("P10-TENANT-003: Organization B cannot update Organization A's FAQ entry by direct id", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t10-003-a');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ question: { en: 'Q', ar: 'س' }, answer: { en: 'A', ar: 'ج' } })
      .expect(201);

    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('t10-003-b');

    await request(app.getHttpServer())
      .patch(`/academies/${academyB.id}/website/faq-entries/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ visible: false })
      .expect(404);

    const row = await admin.websiteFaqEntry.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(row.visible).toBe(true);
  });

  it("P10-TENANT-004: Organization B cannot publish or archive Organization A's FAQ entry by direct id", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t10-004-a');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ question: { en: 'Q', ar: 'س' }, answer: { en: 'A', ar: 'ج' } })
      .expect(201);

    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('t10-004-b');

    await request(app.getHttpServer())
      .post(`/academies/${academyB.id}/website/faq-entries/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/academies/${academyB.id}/website/faq-entries/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);

    const row = await admin.websiteFaqEntry.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(row.status).toBe('draft');
  });

  it("P10-TENANT-005: Organization B's FAQ list never includes Organization A's entries", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t10-005-a');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        question: { en: 'unique-marker-question', ar: 'س' },
        answer: { en: 'A', ar: 'ج' },
      })
      .expect(201);

    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('t10-005-b');

    const list = await request(app.getHttpServer())
      .get(`/academies/${academyB.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(200);
    expect(list.body.items.map((e: { id: string }) => e.id)).not.toContain(
      created.body.id,
    );
  });

  it("P10-TENANT-006: a website page's section cannot reference another organization's FAQ/Testimonial library entry, even though the id genuinely exists", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t10-006-a');
    const { academy: academyB, owner: ownerB } = await seedManagedAcademy('t10-006-b');

    const faqB = await request(app.getHttpServer())
      .post(`/academies/${academyB.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ question: { en: 'Org B Q', ar: 'س' }, answer: { en: 'Org B A', ar: 'ج' } })
      .expect(201);

    const page = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/pages`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ title: 'Cross Org FAQ Page', slug: 'cross-org-faq-page' })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/academies/${academyA.id}/website/pages/${page.body.id}`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        sections: [
          {
            id: 'sec-faq-cross',
            type: 'faq',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: { items: [], libraryEntryIds: [faqB.body.id] },
          },
        ],
      })
      .expect(400);
  });
});
