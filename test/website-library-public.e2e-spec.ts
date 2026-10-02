/**
 * P3 — the FAQ & testimonial content library on the PUBLIC site.
 *
 * A section references library entries by id; the public pages payload
 * carries them expanded (`config.libraryEntries`), so a visitor's browser
 * never needs the authenticated management API. Pinned here against the
 * real database (RLS, the repository's WHERE clause, the Redis cache):
 *   - only published + visible entries of THIS Academy are expanded, in the
 *     Owner's order — a draft, a hidden, an archived and another Academy's
 *     entry (planted directly in the page row, past write-time validation)
 *     are all dropped;
 *   - only public fields leave the server;
 *   - an edit, a hide and an archive show on the very next public read —
 *     not after the pages cache's TTL.
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

const lt = (en: string) => ({ en, ar: `${en} (ar)` });
const visibility = { desktop: true, tablet: true, mobile: true };

describe('Content library on the public website (e2e)', () => {
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

  async function signUpAndSignIn(label: string) {
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
    return {
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function seedManagedAcademy(label: string) {
    const owner = await signUpAndSignIn(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { owner, academy };
  }

  const api = (token: string) => ({
    post: (url: string, body: object = {}) =>
      request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    patch: (url: string, body: object) =>
      request(app.getHttpServer())
        .patch(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`),
  });

  async function faqEntry(
    token: string,
    academyId: string,
    label: string,
    publish = true,
  ) {
    const created = await api(token)
      .post(`/academies/${academyId}/website/faq-entries`, {
        question: lt(`Q ${label}`),
        answer: lt(`A ${label}`),
      })
      .expect(201);
    if (publish) {
      await api(token)
        .post(`/academies/${academyId}/website/faq-entries/${created.body.id}/publish`)
        .expect(201);
    }
    return created.body.id as string;
  }

  async function publicSections(academyId: string) {
    const pages = await request(app.getHttpServer())
      .get(`/public/websites/${academyId}/pages`)
      .expect(200);
    const page = (
      pages.body as {
        slug: string;
        sections: { id: string; config: Record<string, unknown> }[];
      }[]
    ).find((p) => p.slug === 'library');
    return Object.fromEntries(page!.sections.map((s) => [s.id, s.config]));
  }

  it('expands only published, visible, same-Academy entries, in order, with public fields only; edits show on the next read', async () => {
    const { owner, academy } = await seedManagedAcademy('lib-pub');
    const other = await seedManagedAcademy('lib-pub-other');
    const base = `/academies/${academy.id}/website`;

    const shown = await faqEntry(owner.token, academy.id, 'shown');
    const second = await faqEntry(owner.token, academy.id, 'second');
    const hidden = await faqEntry(owner.token, academy.id, 'hidden');
    await api(owner.token)
      .patch(`${base}/faq-entries/${hidden}`, { visible: false })
      .expect(200);
    const draft = await faqEntry(owner.token, academy.id, 'draft', false);
    const archived = await faqEntry(owner.token, academy.id, 'archived');
    await api(owner.token).post(`${base}/faq-entries/${archived}/archive`).expect(201);
    const foreign = await faqEntry(other.owner.token, other.academy.id, 'foreign');

    const testimonial = await api(owner.token)
      .post(`${base}/testimonial-entries`, {
        quote: lt('Great course'),
        authorName: 'Lina',
        authorRole: lt('Student'),
      })
      .expect(201);
    await api(owner.token)
      .post(`${base}/testimonial-entries/${testimonial.body.id}/publish`)
      .expect(201);

    const page = await api(owner.token)
      .post(`${base}/pages`, { title: 'Library', slug: 'library' })
      .expect(201);
    const version = (await api(owner.token).get(`${base}/pages/${page.body.id}`)).body
      .version;
    await api(owner.token)
      .patch(`${base}/pages/${page.body.id}`, {
        visible: true,
        expectedVersion: version,
        sections: [
          {
            id: 'faq',
            type: 'faq',
            enabled: true,
            visibility,
            config: {
              items: [],
              libraryEntryIds: [second, hidden, draft, shown, archived],
            },
          },
          {
            id: 'quotes',
            type: 'testimonials',
            enabled: true,
            visibility,
            config: { items: [], libraryEntryIds: [testimonial.body.id] },
          },
        ],
      })
      .expect(200);
    // Write-time validation refuses another Academy's id (covered by the
    // tenant-isolation suite); plant one in the stored row to prove the
    // public read is its own gate.
    const stored = await admin.websitePage.findUniqueOrThrow({
      where: { id: page.body.id },
    });
    const sections = stored.sections as {
      id: string;
      config: { libraryEntryIds: string[] };
    }[];
    sections[0].config.libraryEntryIds.push(foreign);
    await admin.websitePage.update({ where: { id: page.body.id }, data: { sections } });
    await api(owner.token).post(`${base}/publish`).expect(201);

    let configs = await publicSections(academy.id);
    expect(configs.faq.libraryEntries).toEqual([
      { id: second, question: lt('Q second'), answer: lt('A second') },
      { id: shown, question: lt('Q shown'), answer: lt('A shown') },
    ]);
    expect(configs.quotes.libraryEntries).toEqual([
      {
        id: testimonial.body.id,
        quote: lt('Great course'),
        authorName: 'Lina',
        authorRole: lt('Student'),
      },
    ]);
    const publicText = JSON.stringify(configs);
    for (const leak of [
      'Q hidden',
      'Q draft',
      'Q archived',
      'Q foreign',
      '"status"',
      '"visible"',
      '"order"',
    ]) {
      expect(publicText).not.toContain(leak);
    }

    // The cache does not hold an edit back.
    await api(owner.token)
      .patch(`${base}/faq-entries/${shown}`, { question: lt('Q shown, edited') })
      .expect(200);
    configs = await publicSections(academy.id);
    expect((configs.faq.libraryEntries as { question: unknown }[])[1].question).toEqual(
      lt('Q shown, edited'),
    );

    // Nor a hide, nor an archive.
    await api(owner.token)
      .patch(`${base}/faq-entries/${shown}`, { visible: false })
      .expect(200);
    await api(owner.token).post(`${base}/faq-entries/${second}/archive`).expect(201);
    configs = await publicSections(academy.id);
    expect(configs.faq.libraryEntries).toEqual([]);
  });
});
