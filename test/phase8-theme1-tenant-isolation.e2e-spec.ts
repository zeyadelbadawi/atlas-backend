/**
 * Theme 1 plan Phase 8 — adversarial tenant isolation for every surface
 * Theme 1 reads or writes (website configuration and brand palette,
 * publish, pages and sections, FAQ/testimonial library, media,
 * provisioning, public website).
 *
 * Actors (real HTTP, real guards, real RLS):
 *   - `ownerA`  — owns Organization A (Academies A1, A2) and A1's owner;
 *   - `ownerB`  — owns Organization B (Academy B1): the cross-tenant attacker;
 *   - `memberA` — an Organization A member with no Academy role;
 *   - `instructorA1` — an Instructor in A1;
 *   - `managerA2` — a Manager scoped to A2 only (same Organization as A1).
 *
 * Every refused write is also checked for "nothing changed" in the
 * database — a 403 that still wrote would be the worst outcome.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedMediaAsset,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { uniqueName } from './utils/unique-name';

jest.setTimeout(60000);

type Actor = { userId: string; accessToken: string };
type Method = 'get' | 'post' | 'patch' | 'delete';

describe('Phase 8 — Theme 1 tenant isolation (adversarial)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  let ownerA: Actor;
  let ownerB: Actor;
  let memberA: Actor;
  let instructorA1: Actor;
  let managerA2: Actor;
  let orgA: { id: string };
  let orgB: { id: string };
  let a1: { id: string };
  let a2: { id: string };
  let b1: { id: string };
  let a1Page: { id: string; version: number };
  let b1Page: { id: string };
  let a1Asset: { id: string };
  let b1Asset: { id: string };
  let a1Faq: { id: string };
  let b1Faq: { id: string };
  let a1Testimonial: { id: string };
  let b1Course: { id: string };
  let a1Request: { id: string };

  async function actor(label: string): Promise<Actor> {
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

  const call = (who: Actor, method: Method, path: string, body?: unknown) => {
    const req = request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${who.accessToken}`);
    return body === undefined ? req : req.send(body as object);
  };

  const lt = (en: string) => ({ en, ar: `ع ${en}` });

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    await flushRateLimitKeys();

    ownerA = await actor('p8-owner-a');
    ownerB = await actor('p8-owner-b');
    memberA = await actor('p8-member-a');
    instructorA1 = await actor('p8-instructor-a1');
    managerA2 = await actor('p8-manager-a2');

    orgA = await seedOrganizationWithOwner(admin, ownerA.userId, 'p8-org-a');
    orgB = await seedOrganizationWithOwner(admin, ownerB.userId, 'p8-org-b');
    await seedActiveSubscriptionForOrg(admin, orgA.id, 'p8-a');
    await seedActiveSubscriptionForOrg(admin, orgB.id, 'p8-b');
    a1 = await seedAcademy(admin, orgA.id, 'p8-a1');
    a2 = await seedAcademy(admin, orgA.id, 'p8-a2');
    b1 = await seedAcademy(admin, orgB.id, 'p8-b1');
    await seedAcademyMember(admin, a1.id, ownerA.userId, 'owner');
    await seedAcademyMember(admin, a2.id, ownerA.userId, 'owner');
    await seedAcademyMember(admin, b1.id, ownerB.userId, 'owner');
    await seedMembership(admin, orgA.id, memberA.userId, 'member');
    await seedAcademyMember(admin, a1.id, instructorA1.userId, 'instructor');
    await seedAcademyMember(admin, a2.id, managerA2.userId, 'manager');

    // Real website state in A1 and B1, created through the API.
    const page = await call(ownerA, 'post', `/academies/${a1.id}/website/pages`, {
      title: 'Reviews',
      slug: 'reviews',
    }).expect(201);
    a1Page = { id: page.body.id, version: page.body.version };
    const bPage = await call(ownerB, 'post', `/academies/${b1.id}/website/pages`, {
      title: 'Private B',
      slug: 'private-b',
    }).expect(201);
    b1Page = { id: bPage.body.id };
    a1Asset = await seedMediaAsset(admin, a1.id, 10n);
    b1Asset = await seedMediaAsset(admin, b1.id, 10n);
    const faqA = await call(ownerA, 'post', `/academies/${a1.id}/website/faq-entries`, {
      question: lt('Q A?'),
      answer: lt('A'),
    }).expect(201);
    a1Faq = { id: faqA.body.id };
    const faqB = await call(ownerB, 'post', `/academies/${b1.id}/website/faq-entries`, {
      question: lt('Q B?'),
      answer: lt('B'),
    }).expect(201);
    b1Faq = { id: faqB.body.id };
    const testimonial = await call(
      ownerA,
      'post',
      `/academies/${a1.id}/website/testimonial-entries`,
      { quote: lt('Real quote'), authorName: 'Real Person' },
    ).expect(201);
    a1Testimonial = { id: testimonial.body.id };
    b1Course = await seedCourse(admin, b1.id, 'B course', {
      status: 'published',
      visibility: 'public',
    });
    const provisioning = await call(
      ownerA,
      'post',
      `/organizations/${orgA.id}/provisioning-requests`,
      {
        academyName: uniqueName('P8 Provisioned'),
        requestedSubdomain: `p8prov${Date.now()}`,
        idempotencyKey: `p8prov-${Date.now()}`,
      },
    ).expect(201);
    a1Request = { id: provisioning.body.id };
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  /** A1's website state that no refused call may change. */
  async function a1Snapshot() {
    const [configuration, pages, faq, media] = await Promise.all([
      admin.websiteConfiguration.findUnique({ where: { academyId: a1.id } }),
      admin.websitePage.findMany({ where: { academyId: a1.id }, orderBy: { id: 'asc' } }),
      admin.websiteFaqEntry.findMany({
        where: { academyId: a1.id },
        orderBy: { id: 'asc' },
      }),
      admin.mediaAsset.findMany({ where: { academyId: a1.id }, orderBy: { id: 'asc' } }),
    ]);
    return JSON.stringify({ configuration, pages, faq, media }, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  }

  /** Every Theme 1 academy route, with a body that passes validation. */
  function a1Routes(): Array<[Method, string, unknown?]> {
    const base = `/academies/${a1.id}`;
    return [
      ['get', `${base}/website/configuration`],
      [
        'patch',
        `${base}/website/configuration`,
        { brand: { primaryColor: '0 84% 40%' } },
      ],
      [
        'patch',
        `${base}/website/configuration`,
        { brand: { palette: { seeds: { primary: '0 84% 40%' }, status: 'confirmed' } } },
      ],
      ['post', `${base}/website/publish`],
      ['post', `${base}/website/unpublish`],
      ['get', `${base}/website/pages`],
      ['get', `${base}/website/pages/${a1Page.id}`],
      ['post', `${base}/website/pages`, { title: 'Injected', slug: 'injected' }],
      [
        'patch',
        `${base}/website/pages/${a1Page.id}`,
        { sections: [], expectedVersion: a1Page.version },
      ],
      [
        'post',
        `${base}/website/pages/${a1Page.id}/sections/reorder`,
        { orderedIds: ['sec-a'] },
      ],
      ['post', `${base}/website/pages/${a1Page.id}/editing-session`],
      ['delete', `${base}/website/pages/${a1Page.id}`],
      ['get', `${base}/website/faq-entries`],
      ['get', `${base}/website/faq-entries/${a1Faq.id}`],
      ['post', `${base}/website/faq-entries`, { question: lt('X?'), answer: lt('X') }],
      ['patch', `${base}/website/faq-entries/${a1Faq.id}`, { question: lt('Changed?') }],
      ['post', `${base}/website/faq-entries/${a1Faq.id}/publish`],
      ['post', `${base}/website/faq-entries/${a1Faq.id}/archive`],
      ['get', `${base}/website/testimonial-entries`],
      ['post', `${base}/website/testimonial-entries/${a1Testimonial.id}/publish`],
      ['patch', `${base}/media/${a1Asset.id}`, { altText: 'changed' }],
      ['post', `${base}/media/${a1Asset.id}/archive`],
      ['post', `${base}/media/archive-batch`, { assetIds: [a1Asset.id] }],
    ];
  }

  it('another Organization owner is refused on every Theme 1 route of A1, and nothing changes', async () => {
    const before = await a1Snapshot();
    for (const [method, path, body] of a1Routes()) {
      const res = await call(ownerB, method, path, body);
      expect({ route: `${method} ${path}`, status: res.status }).toEqual({
        route: `${method} ${path}`,
        status: 403,
      });
    }
    // Media reads too.
    await call(ownerB, 'get', `/academies/${a1.id}/media`).expect(403);
    await call(ownerB, 'get', `/academies/${a1.id}/media/${a1Asset.id}`).expect(403);
    expect(await a1Snapshot()).toBe(before);
  });

  it('an Organization member with no Academy role, and an Instructor, are refused every website read and write', async () => {
    const before = await a1Snapshot();
    for (const who of [memberA, instructorA1]) {
      for (const [method, path, body] of a1Routes()) {
        if (!path.includes('/website/')) continue;
        const res = await call(who, method, path, body);
        expect({ route: `${method} ${path}`, status: res.status }).toEqual({
          route: `${method} ${path}`,
          status: 403,
        });
      }
    }
    expect(await a1Snapshot()).toBe(before);
  });

  it("a Manager of A2 cannot reach A1's website or media, although both share an Organization", async () => {
    const before = await a1Snapshot();
    for (const [method, path, body] of a1Routes()) {
      const res = await call(managerA2, method, path, body);
      expect({ route: `${method} ${path}`, status: res.status }).toEqual({
        route: `${method} ${path}`,
        status: 403,
      });
    }
    expect(await a1Snapshot()).toBe(before);
    // Their own Academy works (the check is scope, not a blanket refusal).
    await call(managerA2, 'get', `/academies/${a2.id}/website/configuration`).expect(200);
  });

  it("ID smuggling: another tenant's page, media or FAQ id under one's own Academy path is not found", async () => {
    const own = `/academies/${a1.id}`;
    const bPageBefore = await admin.websitePage.findUnique({ where: { id: b1Page.id } });
    await call(ownerA, 'get', `${own}/website/pages/${b1Page.id}`).expect(404);
    const patched = await call(ownerA, 'patch', `${own}/website/pages/${b1Page.id}`, {
      sections: [],
      expectedVersion: 1,
    });
    expect(patched.status).toBe(404);
    const deleted = await call(ownerA, 'delete', `${own}/website/pages/${b1Page.id}`);
    expect(deleted.status).toBe(404);
    expect(await admin.websitePage.findUnique({ where: { id: b1Page.id } })).toEqual(
      bPageBefore,
    );

    await call(ownerA, 'get', `${own}/media/${b1Asset.id}`).expect(404);
    const archived = await call(ownerA, 'post', `${own}/media/${b1Asset.id}/archive`);
    expect(archived.status).toBe(404);
    const batch = await call(ownerA, 'post', `${own}/media/archive-batch`, {
      assetIds: [b1Asset.id],
    });
    expect([200, 201, 404]).toContain(batch.status);
    expect(
      (await admin.mediaAsset.findUnique({ where: { id: b1Asset.id } }))?.status,
    ).toBe('active');

    await call(ownerA, 'get', `${own}/website/faq-entries/${b1Faq.id}`).expect(404);
    const faqPatch = await call(
      ownerA,
      'patch',
      `${own}/website/faq-entries/${b1Faq.id}`,
      {
        question: lt('Hijacked?'),
      },
    );
    expect(faqPatch.status).toBe(404);
    const faqAfter = await admin.websiteFaqEntry.findUnique({ where: { id: b1Faq.id } });
    expect((faqAfter?.question as { en: string }).en).toBe('Q B?');
  });

  it("a website section cannot reference another Academy's course, FAQ entry or page", async () => {
    const visibility = { desktop: true, tablet: true, mobile: true };
    const featured = (courseIds: string[]) => ({
      id: 'sec-featured',
      type: 'featuredCourses',
      enabled: true,
      visibility,
      config: {
        title: lt('Picked'),
        mode: 'selected',
        courseIds,
        layout: 'grid',
        count: 3,
        showPrice: true,
        showInstructor: true,
      },
    });
    const faq = (libraryEntryIds: string[]) => ({
      id: 'sec-faq',
      type: 'faq',
      enabled: true,
      visibility,
      config: { items: [], libraryEntryIds },
    });
    const cta = (pageId: string) => ({
      id: 'sec-cta',
      type: 'cta',
      enabled: true,
      visibility,
      config: { title: lt('Go'), cta: { label: lt('Go'), pageId } },
    });
    const path = `/academies/${a1.id}/website/pages/${a1Page.id}`;
    const before = await admin.websitePage.findUnique({ where: { id: a1Page.id } });

    for (const sections of [
      [featured([b1Course.id])],
      [faq([b1Faq.id])],
      [cta(b1Page.id)],
    ]) {
      const res = await call(ownerA, 'patch', path, {
        expectedVersion: a1Page.version,
        sections,
      });
      expect({ type: sections[0].type, status: res.status }).toEqual({
        type: sections[0].type,
        status: 400,
      });
    }
    expect(await admin.websitePage.findUnique({ where: { id: a1Page.id } })).toEqual(
      before,
    );

    // Positive control: the same shapes pointing at A1's own ids are accepted,
    // so the refusals above are about the foreign ids, not the payload.
    const ok = await call(ownerA, 'patch', path, {
      expectedVersion: a1Page.version,
      sections: [faq([a1Faq.id]), cta(a1Page.id)],
    });
    expect(ok.status).toBe(200);
    a1Page.version = ok.body.version;
  });

  it("public media: an Academy's file is served only under its own Academy id, and uploads are scoped", async () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const upload = {
      fileName: 'logo.png',
      mimeType: 'image/png',
      sizeBytes: Buffer.from(png, 'base64').length,
      dataUrl: `data:image/png;base64,${png}`,
    };
    // Writing into another tenant's library is refused, before any storage write.
    await call(ownerA, 'post', `/academies/${b1.id}/media`, upload).expect(403);
    await call(managerA2, 'post', `/academies/${a1.id}/media`, upload).expect(403);

    const uploaded = await call(
      ownerB,
      'post',
      `/academies/${b1.id}/media`,
      upload,
    ).expect(201);
    const ownUrl = String(uploaded.body.url).replace(/^\/api\/v1/, '');
    await request(app.getHttpServer()).get(ownUrl).expect(200);
    // The same object name under another Academy's id is a different key: 404.
    const fileName = ownUrl.split('/').pop()!;
    await request(app.getHttpServer())
      .get(`/public/media/academies/${a1.id}/${fileName}`)
      .expect(404);
  });

  it('the Academy logo accepts only image references: javascript:, blob:, other schemes and malformed values are refused', async () => {
    const path = `/academies/${a1.id}/branding`;
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const before = await admin.academy.findUnique({
      where: { id: a1.id },
      select: { logoUrl: true },
    });
    for (const logo of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'blob:https://evil.example/0b1c',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'file:///etc/passwd',
      'not a url',
      '//evil.example/logo.png',
    ]) {
      const res = await call(ownerA, 'patch', path, { logo });
      expect({ logo, status: res.status }).toEqual({ logo, status: 400 });
    }
    expect(
      await admin.academy.findUnique({ where: { id: a1.id }, select: { logoUrl: true } }),
    ).toEqual(before);

    // What real clients send keeps working: an uploaded media path, an
    // external https logo, a legacy inline raster, and clearing it.
    for (const logo of [
      `/api/v1/public/media/academies/${a1.id}/11111111-2222-3333-4444-555555555555.png`,
      'https://cdn.example.com/logo.png',
      `data:image/png;base64,${png}`,
      '',
    ]) {
      const res = await call(ownerA, 'patch', path, { logo });
      expect({ logo, status: res.status }).toEqual({ logo, status: 200 });
    }
  });

  it('provisioning requests are Organization-scoped: another owner can neither list, read, retry nor cancel them', async () => {
    await call(ownerB, 'get', `/organizations/${orgA.id}/provisioning-requests`).expect(
      403,
    );
    await call(
      ownerB,
      'get',
      `/organizations/${orgA.id}/provisioning-requests/${a1Request.id}`,
    ).expect(403);
    // Through their own Organization's path, A's request id does not exist.
    await call(
      ownerB,
      'get',
      `/organizations/${orgB.id}/provisioning-requests/${a1Request.id}`,
    ).expect(404);
    for (const action of ['retry', 'cancel']) {
      const res = await call(
        ownerB,
        'post',
        `/organizations/${orgB.id}/provisioning-requests/${a1Request.id}/${action}`,
      );
      expect(res.status).toBe(404);
    }
    // And only a Platform Owner reaches the platform provisioning console.
    await call(ownerA, 'get', '/provisioning-requests').expect(403);
  });

  it("public endpoints never cross Academies: another Academy's course, an unpublished site, unknown ids", async () => {
    // A1 published; B1's course requested under A1's public path.
    await call(ownerA, 'post', `/academies/${a1.id}/website/publish`).expect(201);
    const pub = request(app.getHttpServer());
    await pub.get(`/public/websites/${a1.id}/courses/${b1Course.id}`).expect(404);
    await request(app.getHttpServer())
      .get(`/public/websites/${a1.id}/courses/${b1Course.id}/curriculum`)
      .expect(404);
    // B1 is unpublished: its website is invisible, even by id.
    await request(app.getHttpServer()).get(`/public/websites/${b1.id}`).expect(404);
    await request(app.getHttpServer()).get(`/public/websites/${b1.id}/pages`).expect(404);
    // Unknown and malformed ids: a clean 404, never a 500.
    for (const id of [
      '00000000-0000-0000-0000-000000000000',
      'not-a-uuid',
      "1' OR '1'='1",
    ]) {
      const res = await request(app.getHttpServer()).get(
        `/public/websites/${encodeURIComponent(id)}/pages`,
      );
      expect(res.status).toBe(404);
    }
    const unknownHost = await request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname: 'no-such-academy-p8' });
    expect(unknownHost.status).toBe(404);
  });
});
