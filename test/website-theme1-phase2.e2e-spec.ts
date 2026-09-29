/**
 * Theme 1 plan Phase 2 (e2e, real Postgres + Redis): the public category
 * listing, sample social proof (§D.4) and the new section contracts, through
 * the real HTTP surface.
 *
 *   - `GET public/websites/:id/categories`: only categories with published,
 *     public courses, with those counts; public fields only; 404 for an
 *     unknown Academy; never another Academy's categories.
 *   - A `sample: true` testimonial is stored for the Owner, listed in the
 *     publish response, and absent from the public pages payload.
 *   - The four new section types and field extensions save; a dangerous
 *     image value is rejected with a field violation.
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
  seedCourseCategory,
  seedOrganizationWithOwner,
} from './utils/db-admin';

const lt = (en: string) => ({ en, ar: '' });
const visibility = { desktop: true, tablet: true, mobile: true };

describe('Website — Theme 1 Phase 2 contracts (e2e)', () => {
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
    const email = uniqueTestEmail(`${label}-owner`);
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    const owner = { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { owner, org, academy };
  }

  async function createPage(token: string, academyId: string, slug: string) {
    const page = await request(app.getHttpServer())
      .post(`/academies/${academyId}/website/pages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: `Page ${slug}`, slug })
      .expect(201);
    return { id: page.body.id as string, version: page.body.version as number };
  }

  function savePage(
    token: string,
    academyId: string,
    page: { id: string; version: number },
    sections: unknown[],
  ) {
    return request(app.getHttpServer())
      .patch(`/academies/${academyId}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ visible: true, sections, expectedVersion: page.version });
  }

  describe('public categories', () => {
    it('lists only categories with published, public courses, with those counts', async () => {
      const { academy } = await seedManagedAcademy('p2-cat');
      const design = await seedCourseCategory(admin, academy.id, 'Design');
      const business = await seedCourseCategory(admin, academy.id, 'Business');
      const draftsOnly = await seedCourseCategory(admin, academy.id, 'Drafts only');
      await seedCourseCategory(admin, academy.id, 'Empty');
      await seedCourse(admin, academy.id, 'UX', {
        categoryId: design.id,
        status: 'published',
        visibility: 'public',
      });
      await seedCourse(admin, academy.id, 'UI', {
        categoryId: design.id,
        status: 'published',
        visibility: 'public',
      });
      await seedCourse(admin, academy.id, 'Private', {
        categoryId: design.id,
        status: 'published',
        visibility: 'private',
      });
      await seedCourse(admin, academy.id, 'Finance', {
        categoryId: business.id,
        status: 'published',
        visibility: 'public',
      });
      await seedCourse(admin, academy.id, 'WIP', {
        categoryId: draftsOnly.id,
        status: 'draft',
        visibility: 'public',
      });

      const response = await request(app.getHttpServer())
        .get(`/public/websites/${academy.id}/categories`)
        .expect(200);

      expect(
        response.body.map((c: { name: string; courseCount: number }) => [
          c.name,
          c.courseCount,
        ]),
      ).toEqual([
        ['Business', 1],
        ['Design', 2],
      ]);
      // Public fields only.
      for (const category of response.body) {
        expect(Object.keys(category).sort()).toEqual([
          'courseCount',
          'id',
          'name',
          'slug',
        ]);
      }
    });

    it('is 404 for an unknown Academy, and never shows another Academy’s categories', async () => {
      await request(app.getHttpServer())
        .get('/public/websites/00000000-0000-0000-0000-000000000000/categories')
        .expect(404);

      const a = await seedManagedAcademy('p2-cat-a');
      const b = await seedManagedAcademy('p2-cat-b');
      const onlyInA = await seedCourseCategory(admin, a.academy.id, 'Only in A');
      await seedCourse(admin, a.academy.id, 'A course', {
        categoryId: onlyInA.id,
        status: 'published',
        visibility: 'public',
      });

      const fromB = await request(app.getHttpServer())
        .get(`/public/websites/${b.academy.id}/categories`)
        .expect(200);
      expect(fromB.body).toEqual([]);
    });
  });

  describe('sample social proof (§D.4)', () => {
    it('keeps samples for the Owner, lists them on publish, and strips them from the public payload', async () => {
      const { owner, academy } = await seedManagedAcademy('p2-sample');
      const page = await createPage(owner.accessToken, academy.id, 'reviews');
      await savePage(owner.accessToken, academy.id, page, [
        {
          id: 'sec-t',
          type: 'testimonials',
          enabled: true,
          visibility,
          config: {
            title: lt('What learners say'),
            items: [
              {
                id: 'real',
                quote: lt('Real quote'),
                authorName: 'Real Person',
                rating: 5,
              },
              {
                id: 'fake',
                quote: lt('Sample quote'),
                authorName: 'Sample Person',
                sample: true,
              },
            ],
          },
        },
      ]).expect(200);

      // The Owner's own view still has the sample (it's editable content).
      const ownerView = await request(app.getHttpServer())
        .get(`/academies/${academy.id}/website/pages/${page.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(ownerView.body.sections[0].config.items).toHaveLength(2);

      const published = await request(app.getHttpServer())
        .post(`/academies/${academy.id}/website/publish`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(201);
      expect(published.body.status).toBe('published');
      expect(published.body.sampleContent).toEqual([
        {
          pageId: page.id,
          pageTitle: 'Page reviews',
          sectionId: 'sec-t',
          sectionType: 'testimonials',
          sampleItems: 1,
        },
      ]);

      const publicPages = await request(app.getHttpServer())
        .get(`/public/websites/${academy.id}/pages`)
        .expect(200);
      const publicText = JSON.stringify(publicPages.body);
      expect(publicText).not.toContain('Sample quote');
      expect(publicText).not.toContain('"sample":true');
      const reviews = publicPages.body.find(
        (p: { slug: string }) => p.slug === 'reviews',
      );
      expect(reviews.sections[0].config.items.map((i: { id: string }) => i.id)).toEqual([
        'real',
      ]);

      // Served from cache the second time — still stripped.
      const again = await request(app.getHttpServer())
        .get(`/public/websites/${academy.id}/pages/reviews`)
        .expect(200);
      expect(JSON.stringify(again.body)).not.toContain('Sample quote');
    });

    it('publishing with no samples reports an empty list', async () => {
      const { owner, academy } = await seedManagedAcademy('p2-nosample');
      const published = await request(app.getHttpServer())
        .post(`/academies/${academy.id}/website/publish`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(201);
      expect(published.body.sampleContent).toEqual([]);
    });
  });

  describe('brand palette (§F.4.3)', () => {
    function patchBrand(token: string, academyId: string, brand: unknown) {
      return request(app.getHttpServer())
        .patch(`/academies/${academyId}/website/configuration`)
        .set('Authorization', `Bearer ${token}`)
        .send({ brand });
    }

    it('derives, validates and stores the palette server-side; legacy colours = seeds; the public read hides private fields', async () => {
      const { owner, academy } = await seedManagedAcademy('p2-palette');
      const saved = await patchBrand(owner.accessToken, academy.id, {
        palette: {
          seeds: {
            primary: '24 95% 53%',
            secondary: '199 89% 38%',
            accent: '43 96% 56%',
          },
          status: 'confirmed',
          source: 'logo',
          // A tampered client's roles are ignored, not stored.
          roles: { cta: '60 100% 90%' },
          confirmedBy: 'someone-else',
          extraction: {
            logoFingerprint: 'b'.repeat(64),
            candidates: [],
            flags: ['neonSeed'],
          },
        },
      }).expect(200);

      const palette = saved.body.brand.palette;
      expect(palette.algorithmVersion).toBe('bp-1');
      expect(palette.roles.cta).not.toBe('60 100% 90%');
      expect(palette.confirmedBy).toBe(owner.userId);
      expect(saved.body.brand).toMatchObject({
        primaryColor: '24 95% 53%',
        secondaryColor: '199 89% 38%',
        accentColor: '43 96% 56%',
      });

      await request(app.getHttpServer())
        .post(`/academies/${academy.id}/website/publish`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(201);
      const publicConfig = await request(app.getHttpServer())
        .get(`/public/websites/${academy.id}`)
        .expect(200);
      expect(publicConfig.body.brand.palette.roles).toEqual(palette.roles);
      expect(publicConfig.body.brand.palette).not.toHaveProperty('confirmedBy');
      expect(publicConfig.body.brand.palette).not.toHaveProperty('confirmedAt');
      expect(publicConfig.body.brand.palette).not.toHaveProperty('extraction');
    });

    it('rejects a crafted failing override with the pair and a suggestion, storing nothing', async () => {
      const { owner, academy } = await seedManagedAcademy('p2-palette-bad');
      const response = await patchBrand(owner.accessToken, academy.id, {
        palette: {
          seeds: { primary: '221 83% 53%' },
          overrides: { foreground: '0 0% 70%' },
          status: 'confirmed',
          source: 'manual',
        },
      }).expect(400);
      expect(response.body.error.violations[0]).toMatchObject({
        field: 'brand.palette.overrides.foreground',
        messageKey: 'website:brand.validation.contrastFailure',
      });
      expect(response.body.error.violations[0].values.suggestion).toMatch(
        /^\d{1,3} \d{1,3}% \d{1,3}%$/,
      );

      const config = await request(app.getHttpServer())
        .get(`/academies/${academy.id}/website/configuration`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(config.body.brand.palette).toBeUndefined();
    });

    it('an Academy never sees another Academy’s palette', async () => {
      const a = await seedManagedAcademy('p2-palette-a');
      const b = await seedManagedAcademy('p2-palette-b');
      await patchBrand(a.owner.accessToken, a.academy.id, {
        palette: {
          seeds: { primary: '262 70% 50%' },
          status: 'proposed',
          source: 'manual',
        },
      }).expect(200);
      // B's owner can't write A's configuration…
      await patchBrand(b.owner.accessToken, a.academy.id, {
        palette: { seeds: { primary: '0 0% 10%' }, status: 'proposed', source: 'manual' },
      }).expect((res) => expect([403, 404]).toContain(res.status));
      // …and B's own configuration carries no palette.
      const configB = await request(app.getHttpServer())
        .get(`/academies/${b.academy.id}/website/configuration`)
        .set('Authorization', `Bearer ${b.owner.accessToken}`)
        .expect(200);
      expect(configB.body.brand.palette).toBeUndefined();
    });
  });

  describe('section contracts', () => {
    it('saves the new section types and field extensions', async () => {
      const { owner, academy } = await seedManagedAcademy('p2-types');
      const page = await createPage(owner.accessToken, academy.id, 'composed');
      const sections = [
        {
          id: 'ph',
          type: 'pageHeader',
          enabled: true,
          visibility,
          config: { title: lt('Our courses'), search: 'courses' },
        },
        {
          id: 'cc',
          type: 'courseCategories',
          enabled: true,
          visibility,
          config: { title: lt('Explore'), maxItems: 8, showCounts: true },
        },
        {
          id: 'st',
          type: 'steps',
          enabled: true,
          visibility,
          config: {
            items: [
              { id: '1', title: lt('Sign up') },
              { id: '2', title: lt('Learn') },
            ],
          },
        },
        {
          id: 'fs',
          type: 'featureSplit',
          enabled: true,
          visibility,
          config: {
            title: lt('Why us'),
            imagePosition: 'end',
            image: 'theme-asset:modern-education/home-benefit',
            items: [{ id: '1', title: lt('Mentors') }],
          },
        },
        {
          id: 'hero',
          type: 'hero',
          enabled: true,
          visibility,
          config: {
            title: lt('Learn something new'),
            highlight: lt('something new'),
            highlights: [{ id: 'h1', label: lt('Certificates') }],
            showSearch: true,
          },
        },
      ];
      const saved = await savePage(owner.accessToken, academy.id, page, sections).expect(
        200,
      );
      expect(saved.body.sections.map((s: { type: string }) => s.type)).toEqual([
        'pageHeader',
        'courseCategories',
        'steps',
        'featureSplit',
        'hero',
      ]);
      expect(saved.body.sections[4].config.highlight).toEqual(lt('something new'));
    });

    it('rejects a dangerous image value', async () => {
      const { owner, academy } = await seedManagedAcademy('p2-image');
      const page = await createPage(owner.accessToken, academy.id, 'img');
      const response = await savePage(owner.accessToken, academy.id, page, [
        {
          id: 'hero',
          type: 'hero',
          enabled: true,
          visibility,
          config: { title: lt('x'), image: 'javascript:alert(1)' },
        },
      ]).expect(400);
      expect(JSON.stringify(response.body)).toContain('validation:invalidImage');
    });
  });
});
