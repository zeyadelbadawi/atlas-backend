/**
 * Task 3 — detailed, understandable audit logs (e2e, real HTTP + Postgres).
 *
 *   A. Newly audited domains write EXACTLY ONE row per mutation, in the
 *      mutation's own transaction (a refused mutation writes none), with
 *      the right actor/academy/organization/role and readable before/after.
 *   B. `GET academies/:id/activity` — the owner sees their own academy's
 *      tenant-visible rows only; another academy (same org) is excluded;
 *      another organization, a Manager and an Instructor are refused.
 *   C. The tenant feed never carries operator-only/security actions or an
 *      email address, and Atlas staff are shown as "Atlas".
 *   D. Cursor pagination and filters (category, action, search, actor).
 *   E. `GET audit-log/feed` — Platform Owner cursor feed with filters;
 *      refused to tenants.
 *   F. The dashboard's recent activity excludes operator-only actions.
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
  seedOrganizationWithOwner,
} from './utils/db-admin';

const REAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

interface Session {
  readonly userId: string;
  readonly accessToken: string;
  readonly email: string;
}

async function signUpAndSignIn(app: INestApplication, label: string): Promise<Session> {
  const email = uniqueTestEmail(label);
  const password = 'correct-horse-battery';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: `${label} Person`, email, password })
    .expect(201);
  const signIn = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password })
    .expect(200);
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken, email };
}

describe('Task 3 — audit activity log (e2e)', () => {
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

  async function world(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { owner, org, academy };
  }

  function auth(session: Session) {
    return { Authorization: `Bearer ${session.accessToken}` };
  }

  function rows(where: Record<string, unknown>) {
    return admin.auditLogEntry.findMany({ where, orderBy: { occurredAt: 'asc' } });
  }

  async function pageVersion(academyId: string, pageId: string): Promise<number> {
    const page = await admin.websitePage.findUniqueOrThrow({ where: { id: pageId } });
    expect(page.academyId).toBe(academyId);
    return page.version;
  }

  /* ------------------------------------------------------------------ */
  /* A. New domain writes                                                */
  /* ------------------------------------------------------------------ */

  it('A1: website page create/update/publish/delete each write exactly one attributed row', async () => {
    const { owner, org, academy } = await world('t3a1');

    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set(auth(owner))
      .send({ title: 'Pricing', slug: 'pricing' })
      .expect(201);
    const pageId = created.body.id as string;

    const createdRows = await rows({ action: 'website_page.created', targetId: pageId });
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]).toMatchObject({
      actorUserId: owner.userId,
      organizationId: org.id,
      academyId: academy.id,
      role: 'owner',
      targetType: 'website_page',
      targetLabel: 'Pricing',
    });

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${pageId}`)
      .set(auth(owner))
      .send({
        title: 'Plans & Pricing',
        expectedVersion: await pageVersion(academy.id, pageId),
        sections: [
          {
            id: 'sec-about',
            type: 'about',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: { title: { en: 'About us' }, body: { en: 'We teach.' } },
          },
        ],
      })
      .expect(200);

    const updatedRows = await rows({ action: 'website_page.updated', targetId: pageId });
    expect(updatedRows).toHaveLength(1);
    expect(updatedRows[0].changes).toMatchObject({
      title: { from: 'Pricing', to: 'Plans & Pricing' },
    });
    expect(updatedRows[0].context).toMatchObject({
      sectionsAdded: 1,
      sectionsRemoved: 0,
      sectionsUpdated: 0,
      sectionCount: 1,
    });

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${pageId}/publish`)
      .set(auth(owner))
      .send({})
      .expect(201);
    expect(
      await rows({ action: 'website_page.published', targetId: pageId }),
    ).toHaveLength(1);

    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/website/pages/${pageId}`)
      .set(auth(owner))
      .expect(204);
    const deletedRows = await rows({ action: 'website_page.deleted', targetId: pageId });
    expect(deletedRows).toHaveLength(1);
    expect(deletedRows[0].targetLabel).toBe('Plans & Pricing');
  });

  it('A2: a refused mutation writes no audit row (same transaction)', async () => {
    const { owner, academy } = await world('t3a2');
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set(auth(owner))
      .send({ title: 'One', slug: 'dupe-slug' })
      .expect(201);
    // The duplicate is refused by the unique constraint inside the create's
    // transaction — the audit insert that would follow never commits.
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set(auth(owner))
      .send({ title: 'Two', slug: 'dupe-slug' })
      .expect(409);

    const created = await rows({ action: 'website_page.created', academyId: academy.id });
    expect(created).toHaveLength(1);
    expect(created[0].targetLabel).toBe('One');

    // A core page cannot be deleted: refused, and nothing recorded.
    const core = await admin.websitePage.findFirstOrThrow({
      where: { academyId: academy.id, pageType: 'core' },
    });
    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/website/pages/${core.id}`)
      .set(auth(owner))
      .expect(403);
    expect(
      await rows({ action: 'website_page.deleted', targetId: core.id }),
    ).toHaveLength(0);
  });

  it('A3: website publish/unpublish, FAQ library, academy update, payment settings and media upload are audited', async () => {
    const { owner, org, academy } = await world('t3a3');
    await seedActiveSubscriptionForOrg(admin, org.id, 't3a3');

    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/configuration`)
      .set(auth(owner))
      .expect(200);
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/publish`)
      .set(auth(owner))
      .expect(201);
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/unpublish`)
      .set(auth(owner))
      .expect(201);
    const published = await rows({ action: 'website.published', academyId: academy.id });
    expect(published).toHaveLength(1);
    expect(published[0].changes).toMatchObject({
      status: { from: 'draft', to: 'published' },
    });
    expect(
      await rows({ action: 'website.unpublished', academyId: academy.id }),
    ).toHaveLength(1);

    const faq = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set(auth(owner))
      .send({
        question: { en: 'What is Atlas?', ar: 'ما هو أطلس؟' },
        answer: { en: 'A platform.', ar: 'منصة.' },
      })
      .expect(201);
    const faqRows = await rows({ action: 'website_faq.created', targetId: faq.body.id });
    expect(faqRows).toHaveLength(1);
    expect(faqRows[0].targetLabel).toBe('What is Atlas?');

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}`)
      .set(auth(owner))
      .send({ name: 'Renamed Academy', contactEmail: 'contact@example.com' })
      .expect(200);
    const academyRows = await rows({ action: 'academy.updated', targetId: academy.id });
    expect(academyRows).toHaveLength(1);
    expect(academyRows[0].changes).toMatchObject({
      name: { to: 'Renamed Academy' },
      contactEmail: { to: '[email hidden]' },
    });
    expect(JSON.stringify(academyRows[0])).not.toContain('contact@example.com');

    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set(auth(owner))
      .send({ paymentCollectionMode: 'atlas_payments' })
      .expect(200);
    const paymentRows = await rows({
      action: 'organization.payment_settings.updated',
      organizationId: org.id,
    });
    expect(paymentRows).toHaveLength(1);
    expect(paymentRows[0].changes).toEqual({
      paymentCollectionMode: { from: 'unconfigured', to: 'atlas_payments' },
    });

    const uploaded = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/media`)
      .set(auth(owner))
      .send({
        fileName: 'logo.png',
        mimeType: 'image/png',
        sizeBytes: Buffer.from(REAL_PNG_BASE64, 'base64').length,
        dataUrl: `data:image/png;base64,${REAL_PNG_BASE64}`,
      })
      .expect(201);
    const mediaRows = await rows({
      action: 'media.uploaded',
      targetId: uploaded.body.id,
    });
    expect(mediaRows).toHaveLength(1);
    expect(mediaRows[0]).toMatchObject({
      academyId: academy.id,
      organizationId: org.id,
      targetLabel: 'logo.png',
    });
  });

  /* ------------------------------------------------------------------ */
  /* B/C. Academy activity log — scope, roles, privacy                    */
  /* ------------------------------------------------------------------ */

  it('B1: the owner sees only their own academy; other academy, other org, manager and instructor are refused or excluded', async () => {
    const { owner, org, academy } = await world('t3b1');
    const sibling = await seedAcademy(admin, org.id, 't3b1-sibling');
    await seedAcademyMember(admin, sibling.id, owner.userId, 'owner');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set(auth(owner))
      .send({ title: 'Mine', slug: 'mine' })
      .expect(201);
    const siblingPage = await request(app.getHttpServer())
      .post(`/academies/${sibling.id}/website/pages`)
      .set(auth(owner))
      .send({ title: 'Sibling secret', slug: 'sibling' })
      .expect(201);

    const feed = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/activity`)
      .set(auth(owner))
      .expect(200);
    const items = feed.body.items as { academyId: string; targetId: string }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.academyId === academy.id)).toBe(true);
    expect(items.some((item) => item.targetId === siblingPage.body.id)).toBe(false);

    // The sibling's entry is not reachable through this academy's detail route.
    const siblingRow = (
      await rows({ action: 'website_page.created', targetId: siblingPage.body.id })
    )[0];
    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/activity/${siblingRow.id}`)
      .set(auth(owner))
      .expect(404);

    // Another organization's owner.
    const stranger = await world('t3b1-stranger');
    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/activity`)
      .set(auth(stranger.owner))
      .expect(403);

    // A Manager and an Instructor of THIS academy.
    for (const role of ['manager', 'instructor'] as const) {
      const member = await signUpAndSignIn(app, `t3b1-${role}`);
      await admin.organizationMembership.create({
        data: { organizationId: org.id, userId: member.userId, role, permissions: [] },
      });
      await seedAcademyMember(admin, academy.id, member.userId, role);
      await request(app.getHttpServer())
        .get(`/academies/${academy.id}/activity`)
        .set(auth(member))
        .expect(403);
    }
  });

  it('C1: the tenant feed excludes security/operator actions and every email; Atlas staff appear as Atlas', async () => {
    const { owner, org, academy } = await world('t3c1');
    const staffEmail = uniqueTestEmail('t3c1-legacy');

    // Rows that historically carried the organization id: an OTP failure
    // (operator-only), a legacy email label, and an Atlas operator action.
    await admin.auditLogEntry.createMany({
      data: [
        {
          id: randomUUID(),
          actorUserId: owner.userId,
          organizationId: org.id,
          academyId: academy.id,
          action: 'auth.otp.failed',
          targetType: 'user',
          targetId: owner.userId,
          context: { ipAddress: '10.1.2.3' },
        },
        {
          id: randomUUID(),
          actorUserId: owner.userId,
          organizationId: org.id,
          academyId: academy.id,
          action: 'academy.manager.added',
          targetType: 'academy_member',
          targetId: randomUUID(),
          targetLabel: staffEmail,
        },
        {
          id: randomUUID(),
          actorUserId: owner.userId,
          organizationId: org.id,
          academyId: academy.id,
          role: 'platform_owner',
          action: 'domain.platform_release',
          targetType: 'domain_connection',
          targetId: randomUUID(),
          targetLabel: 'old.example.org',
        },
      ],
    });

    const feed = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/activity`)
      .set(auth(owner))
      .expect(200);
    const body = JSON.stringify(feed.body);
    expect(body).not.toContain('auth.otp.failed');
    expect(body).not.toContain('10.1.2.3');
    expect(body).not.toContain(staffEmail);
    expect(body).not.toContain(owner.email);
    expect(body).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

    const items = feed.body.items as {
      action: string;
      actor: { name: string; isPlatformStaff: boolean; email?: string };
    }[];
    const release = items.find((item) => item.action === 'domain.platform_release');
    expect(release?.actor).toEqual({ id: 'atlas', name: 'Atlas', isPlatformStaff: true });
    expect(items.every((item) => item.actor.email === undefined)).toBe(true);
  });

  /* ------------------------------------------------------------------ */
  /* D. Pagination and filters                                           */
  /* ------------------------------------------------------------------ */

  it('D1: cursor pagination returns disjoint pages; category/action/search/actor filters narrow', async () => {
    const { owner, academy } = await world('t3d1');
    for (const slug of ['p-one', 'p-two', 'p-three']) {
      await request(app.getHttpServer())
        .post(`/academies/${academy.id}/website/pages`)
        .set(auth(owner))
        .send({ title: `Title ${slug}`, slug })
        .expect(201);
    }
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/faq-entries`)
      .set(auth(owner))
      .send({ question: { en: 'Q?', ar: 'س؟' }, answer: { en: 'A.', ar: 'ج.' } })
      .expect(201);

    const first = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/activity`)
      .query({ limit: 2 })
      .set(auth(owner))
      .expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/activity`)
      .query({ limit: 2, cursor: first.body.nextCursor })
      .set(auth(owner))
      .expect(200);
    const firstIds = (first.body.items as { id: string }[]).map((item) => item.id);
    const secondIds = (second.body.items as { id: string }[]).map((item) => item.id);
    expect(secondIds.length).toBeGreaterThan(0);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);

    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/activity`)
      .query({ cursor: 'not-a-cursor' })
      .set(auth(owner))
      .expect(400);

    const byAction = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/activity`)
      .query({ action: 'website_faq.created' })
      .set(auth(owner))
      .expect(200);
    expect(byAction.body.items).toHaveLength(1);
    expect(byAction.body.items[0].category).toBe('website');

    const bySearch = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/activity`)
      .query({ search: 'title p-two' })
      .set(auth(owner))
      .expect(200);
    expect(bySearch.body.items).toHaveLength(1);
    expect(bySearch.body.items[0].targetLabel).toBe('Title p-two');

    const byCategory = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/activity`)
      .query({ category: 'courses' })
      .set(auth(owner))
      .expect(200);
    expect(byCategory.body.items).toHaveLength(0);

    const byActor = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/activity`)
      .query({ actorUserId: randomUUID() })
      .set(auth(owner))
      .expect(200);
    expect(byActor.body.items).toHaveLength(0);

    // Detail carries before/after.
    const entry = (
      await rows({ action: 'website_faq.created', academyId: academy.id })
    )[0];
    const detail = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/activity/${entry.id}`)
      .set(auth(owner))
      .expect(200);
    expect(detail.body).toMatchObject({
      id: entry.id,
      action: 'website_faq.created',
      actor: { id: owner.userId, isPlatformStaff: false },
    });
  });

  /* ------------------------------------------------------------------ */
  /* E/F. Platform feed and dashboard                                    */
  /* ------------------------------------------------------------------ */

  it('E1: the Platform Owner feed paginates and filters by academy/category; tenants are refused', async () => {
    const { owner, academy } = await world('t3e1');
    for (const slug of ['e-one', 'e-two']) {
      await request(app.getHttpServer())
        .post(`/academies/${academy.id}/website/pages`)
        .set(auth(owner))
        .send({ title: slug, slug })
        .expect(201);
    }
    const operator = await signUpAndSignIn(app, 't3e1-operator');
    await admin.user.update({
      where: { id: operator.userId },
      data: { isPlatformOwner: true },
    });

    const first = await request(app.getHttpServer())
      .get('/audit-log/feed')
      .query({ academyId: academy.id, category: 'website', limit: 1 })
      .set(auth(operator))
      .expect(200);
    expect(first.body.items).toHaveLength(1);
    expect(first.body.items[0]).toMatchObject({
      academyId: academy.id,
      category: 'website',
      action: 'website_page.created',
    });
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(app.getHttpServer())
      .get('/audit-log/feed')
      .query({
        academyId: academy.id,
        category: 'website',
        limit: 1,
        cursor: first.body.nextCursor,
      })
      .set(auth(operator))
      .expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.items[0].id).not.toBe(first.body.items[0].id);

    await request(app.getHttpServer())
      .get('/audit-log/feed')
      .set(auth(owner))
      .expect(403);
  });

  it('F1: the dashboard’s recent activity excludes operator-only actions and carries context for sentences', async () => {
    const { owner, org, academy } = await world('t3f1');
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages`)
      .set(auth(owner))
      .send({ title: 'Dashboard page', slug: 'dash' })
      .expect(201);
    await admin.auditLogEntry.create({
      data: {
        actorUserId: owner.userId,
        organizationId: org.id,
        academyId: academy.id,
        action: 'auth.otp.verified',
        targetType: 'user',
        targetId: owner.userId,
      },
    });

    const dashboard = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/dashboard`)
      .set(auth(owner))
      .expect(200);
    const activity = dashboard.body.recentActivity as {
      action: string;
      category: string;
      context?: Record<string, unknown>;
    }[];
    expect(activity.some((item) => item.action === 'auth.otp.verified')).toBe(false);
    const page = activity.find((item) => item.action === 'website_page.created');
    expect(page).toMatchObject({ category: 'website', context: { slug: 'dash' } });
  });
});
