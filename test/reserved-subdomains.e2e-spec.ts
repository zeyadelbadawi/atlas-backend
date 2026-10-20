/**
 * DL-57 — platform subdomain labels and their look-alikes are refused at
 * every layer: the provisioning request, the availability check, an
 * address change, and the database itself (`atlas_is_reserved_subdomain`,
 * migration 20261122000000). An academy created before a word was reserved
 * keeps saving its settings, because the forms re-send the unchanged slug.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { uniqueName } from './utils/unique-name';
import {
  createAdminPrisma,
  seedAcademy,
  seedActiveSubscriptionForOrg,
  seedAcademyMember,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { isReservedSubdomain } from '../src/provisioning/dto/provisioning.constants';

/** Labels the two implementations must agree on (reserved and free). */
const SAMPLES = [
  'docs',
  'doc',
  'help',
  'docs-2',
  'd0cs',
  'help-center',
  'helpcenter',
  'apidocs',
  'support-desk',
  'status-page',
  'atlas-math',
  'my-atlas',
  '4tlas',
  'admin-panel',
  'adm1n',
  'www2',
  'sign-in',
  'learn',
  'owner',
  'learn-english',
  'math-academy',
  'academy-online',
  'al-nour',
  'mo7amed-math',
  'owner-123',
  'demo-school',
  'helpme',
  'video-lessons',
];

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

describe('Reserved platform subdomains (e2e) — DL-57', () => {
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

  async function arrangeOwner(label: string) {
    const owner = await signUpAndSignIn(app, label);
    const org = await seedOrganizationWithOwner(admin, owner.userId, label);
    await seedActiveSubscriptionForOrg(admin, org.id, org.slug);
    return { owner, org };
  }

  it('the database function agrees with isReservedSubdomain on every sample', async () => {
    const rows = await admin.$queryRaw<{ v: string; reserved: boolean }[]>`
      SELECT v, atlas_is_reserved_subdomain(v) AS reserved FROM unnest(${SAMPLES}::text[]) v`;
    const fromDb = Object.fromEntries(rows.map((r) => [r.v, r.reserved]));
    for (const label of SAMPLES) {
      expect({ label, reserved: fromDb[label] }).toEqual({
        label,
        reserved: isReservedSubdomain(label),
      });
    }
  });

  it.each(['docs', 'help-center', 'd0cs', 'atlas-help'])(
    'a provisioning request for "%s" is refused with 409',
    async (subdomain) => {
      const { owner, org } = await arrangeOwner(`rsv-prov-${subdomain}`);
      const res = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/provisioning-requests`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          academyName: uniqueName('Reserved Academy'),
          requestedSubdomain: subdomain,
          idempotencyKey: `idem-rsv-${subdomain}-${Date.now()}`,
        })
        .expect(409);
      expect(res.body.error.messageKey).toBe('errors.provisioning.subdomainReserved');
    },
  );

  it.each(['docs', 'doc', 'docs-2', 'support-desk'])(
    'availability reports "%s" as reserved',
    async (subdomain) => {
      const { owner } = await arrangeOwner(`rsv-avail-${subdomain}`);
      const res = await request(app.getHttpServer())
        .get('/subdomains/availability')
        .query({ subdomain })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(res.body).toMatchObject({ subdomain, status: 'reserved' });
    },
  );

  it('an ordinary teacher label stays available', async () => {
    const { owner } = await arrangeOwner('rsv-avail-free');
    const subdomain = `learn-english-${Date.now()}`;
    const res = await request(app.getHttpServer())
      .get('/subdomains/availability')
      .query({ subdomain })
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(res.body).toMatchObject({ subdomain, status: 'available' });
  });

  it('changing an academy address to a reserved or too-short label is refused', async () => {
    const { owner, org } = await arrangeOwner('rsv-rename');
    const academy = await seedAcademy(admin, org.id, 'rsv-rename');
    await seedAcademyMember(admin, academy.id, owner.userId);

    const toReserved = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug: 'help' })
      .expect(409);
    expect(toReserved.body.error.messageKey).toBe('errors.academy.slugReserved');

    const tooShort = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ slug: 'ab' })
      .expect(400);
    expect(tooShort.body.error.messageKey).toBe('errors.academy.invalidSlug');
  });

  it('an academy that already holds a now-reserved label keeps saving its settings', async () => {
    const { owner, org } = await arrangeOwner('rsv-legacy');
    const academy = await seedAcademy(admin, org.id, 'rsv-legacy');
    await seedAcademyMember(admin, academy.id, owner.userId);
    // A label taken before it was reserved: written with the trigger off,
    // as the row would have been before migration 20261122000000.
    const legacy = `docs${Date.now()}`;
    await admin.$transaction([
      admin.$executeRawUnsafe(
        'ALTER TABLE academies DISABLE TRIGGER academies_reserved_slug',
      ),
      admin.academy.update({ where: { id: academy.id }, data: { slug: legacy } }),
      admin.$executeRawUnsafe(
        'ALTER TABLE academies ENABLE TRIGGER academies_reserved_slug',
      ),
    ]);

    const renamed = uniqueName('Legacy Academy');
    const res = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: renamed, slug: legacy })
      .expect(200);
    expect(res.body).toMatchObject({ name: renamed, slug: legacy });
  });

  it('the database refuses a reserved label on a direct write to either table', async () => {
    const { owner, org } = await arrangeOwner('rsv-db');
    const academy = await seedAcademy(admin, org.id, 'rsv-db');
    void owner;

    await expect(
      admin.academy.update({ where: { id: academy.id }, data: { slug: 'help-center' } }),
    ).rejects.toThrow(/reserved for Atlas/);
    await expect(
      admin.subdomainAllocation.create({
        data: { academyId: academy.id, subdomain: 'docs', status: 'assigned' },
      }),
    ).rejects.toThrow(/reserved for Atlas/);

    // A free label still writes.
    const free = `rsv-db-ok-${Date.now()}`;
    await expect(
      admin.academy.update({ where: { id: academy.id }, data: { slug: free } }),
    ).resolves.toMatchObject({ slug: free });
  });
});
