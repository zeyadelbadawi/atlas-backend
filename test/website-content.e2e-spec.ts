/**
 * CMS Content Library e2e suite (master plan §21 Phase P10, §10).
 * Exercises `WebsiteContentController`'s real HTTP surface — FAQ and
 * Testimonial entry CRUD, publish/archive lifecycle, pagination/status
 * filtering — including the security-critical localized-field validation.
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

describe('CMS Content Library — FAQ & Testimonial entries (e2e)', () => {
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
    return { owner, org, academy };
  }

  /* ------------------------------ FAQ ------------------------------ */

  it('creates a FAQ entry, auto-assigns order, and it defaults to draft/visible', async () => {
    const { owner, academy } = await seedManagedAcademy('faq-create');

    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        question: { en: 'What is Atlas?', ar: 'ما هو أطلس؟' },
        answer: { en: 'A platform.', ar: 'منصة.' },
      })
      .expect(201);

    expect(created.body).toMatchObject({
      academyId: academy.id,
      question: { en: 'What is Atlas?', ar: 'ما هو أطلس؟' },
      answer: { en: 'A platform.', ar: 'منصة.' },
      order: 0,
      visible: true,
      status: 'draft',
    });
  });

  it('auto-assigns sequential order to successive entries, appended to the end', async () => {
    const { owner, academy } = await seedManagedAcademy('faq-order');
    const payload = (n: number) => ({
      question: { en: `Q${n}`, ar: `س${n}` },
      answer: { en: `A${n}`, ar: `ج${n}` },
    });

    const first = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(payload(1))
      .expect(201);
    const second = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send(payload(2))
      .expect(201);

    expect(first.body.order).toBe(0);
    expect(second.body.order).toBe(1);
  });

  it('rejects a create payload missing the Arabic translation', async () => {
    const { owner, academy } = await seedManagedAcademy('faq-missing-ar');
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ question: { en: 'Q', ar: '' }, answer: { en: 'A', ar: 'ج' } })
      .expect(400);
  });

  it('rejects a question over the max length', async () => {
    const { owner, academy } = await seedManagedAcademy('faq-too-long');
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        question: { en: 'x'.repeat(201), ar: 'س' },
        answer: { en: 'A', ar: 'ج' },
      })
      .expect(400);
  });

  it('updates question/answer/order/visible via PATCH, never accepting a status change through it', async () => {
    const { owner, academy } = await seedManagedAcademy('faq-update');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ question: { en: 'Q', ar: 'س' }, answer: { en: 'A', ar: 'ج' } })
      .expect(201);

    const updated = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/faq-entries/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ visible: false, order: 5 })
      .expect(200);

    expect(updated.body.visible).toBe(false);
    expect(updated.body.order).toBe(5);
    expect(updated.body.status).toBe('draft');
  });

  it('publishes a draft entry, and archiving is terminal — neither publish nor archive succeeds again afterward', async () => {
    const { owner, academy } = await seedManagedAcademy('faq-lifecycle');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ question: { en: 'Q', ar: 'س' }, answer: { en: 'A', ar: 'ج' } })
      .expect(201);

    const published = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(published.body.status).toBe('published');

    const archived = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(archived.body.status).toBe('archived');

    // Row still exists — no hard delete.
    const row = await admin.websiteFaqEntry.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(row.status).toBe('archived');

    // Terminal: neither action succeeds again.
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(409);
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(409);
  });

  it('a draft entry can be archived directly, without ever being published', async () => {
    const { owner, academy } = await seedManagedAcademy('faq-archive-draft');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ question: { en: 'Q', ar: 'س' }, answer: { en: 'A', ar: 'ج' } })
      .expect(201);

    const archived = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(archived.body.status).toBe('archived');
  });

  it('lists FAQ entries with pagination and a status filter', async () => {
    const { owner, academy } = await seedManagedAcademy('faq-list');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ question: { en: 'Q', ar: 'س' }, answer: { en: 'A', ar: 'ج' } })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    const publishedOnly = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/faq-entries`)
      .query({ status: 'published' })
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(publishedOnly.body.items.map((e: { id: string }) => e.id)).toContain(
      created.body.id,
    );

    const draftOnly = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/faq-entries`)
      .query({ status: 'draft' })
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(draftOnly.body.items.map((e: { id: string }) => e.id)).not.toContain(
      created.body.id,
    );
    expect(publishedOnly.body.pagination).toMatchObject({
      totalItems: expect.any(Number),
    });
  });

  it('there is no hard-delete endpoint for a FAQ entry', async () => {
    const { owner, academy } = await seedManagedAcademy('faq-no-delete');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ question: { en: 'Q', ar: 'س' }, answer: { en: 'A', ar: 'ج' } })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/website/faq-entries/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });

  /* --------------------------- Testimonial -------------------------- */

  it('creates a Testimonial entry with optional authorRole/avatar omitted', async () => {
    const { owner, academy } = await seedManagedAcademy('testimonial-create');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/testimonial-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ quote: { en: 'Great!', ar: 'رائع!' }, authorName: 'Jane Doe' })
      .expect(201);

    expect(created.body).toMatchObject({
      academyId: academy.id,
      quote: { en: 'Great!', ar: 'رائع!' },
      authorName: 'Jane Doe',
      order: 0,
      visible: true,
      status: 'draft',
    });
    expect(created.body.authorRole).toBeUndefined();
    expect(created.body.avatar).toBeUndefined();
  });

  it('creates a Testimonial entry with authorRole and avatar present', async () => {
    const { owner, academy } = await seedManagedAcademy('testimonial-full');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/testimonial-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        quote: { en: 'Great!', ar: 'رائع!' },
        authorName: 'Jane Doe',
        authorRole: { en: 'CEO', ar: 'رئيسة' },
        avatar: 'data:image/png;base64,aaaa',
      })
      .expect(201);

    expect(created.body.authorRole).toEqual({ en: 'CEO', ar: 'رئيسة' });
    expect(created.body.avatar).toBe('data:image/png;base64,aaaa');
  });

  it('rejects a missing authorName', async () => {
    const { owner, academy } = await seedManagedAcademy('testimonial-missing-name');
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/testimonial-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ quote: { en: 'Great!', ar: 'رائع!' } })
      .expect(400);
  });

  it('publish/archive lifecycle matches FAQ exactly, and there is no hard-delete endpoint', async () => {
    const { owner, academy } = await seedManagedAcademy('testimonial-lifecycle');
    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/testimonial-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ quote: { en: 'Great!', ar: 'رائع!' }, authorName: 'Jane Doe' })
      .expect(201);

    const published = await request(app.getHttpServer())
      .post(
        `/academies/${academy.id}/website/testimonial-entries/${created.body.id}/publish`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(published.body.status).toBe('published');

    const archived = await request(app.getHttpServer())
      .post(
        `/academies/${academy.id}/website/testimonial-entries/${created.body.id}/archive`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(archived.body.status).toBe('archived');

    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/website/testimonial-entries/${created.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });

  /* --------------------------- Authorization -------------------------- */

  it('a plain org member (no academy role) can read CMS content but cannot write, publish, or archive it', async () => {
    const { academy, org, owner } = await seedManagedAcademy('cms-authz');
    const plainMember = await signUpAndSignIn(app, 'cms-authz-member');
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: plainMember.userId, role: 'member' },
    });

    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ question: { en: 'Q', ar: 'س' }, answer: { en: 'A', ar: 'ج' } })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${plainMember.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set('Authorization', `Bearer ${plainMember.accessToken}`)
      .send({ question: { en: 'Q2', ar: 'س2' }, answer: { en: 'A2', ar: 'ج2' } })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${plainMember.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${plainMember.accessToken}`)
      .expect(403);
  });
});
