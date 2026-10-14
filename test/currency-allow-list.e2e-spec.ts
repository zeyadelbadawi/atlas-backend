/**
 * B0-LRN-05 / B0-COM-05 — an academy currency and a course price currency
 * must be a supported one (EGP for now). A value stored before the rule
 * stays valid when re-sent unchanged (the settings forms re-send it), so
 * a legacy academy can still save its settings; it just cannot switch to a
 * new unsupported currency. Changing the academy currency never rewrites
 * an existing course price, which keeps its own currency.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const UNSUPPORTED = [{ field: 'currency', messageKey: 'validation:unsupportedCurrency' }];
const UNSUPPORTED_PRICE = [
  { field: 'pricing.currency', messageKey: 'validation:unsupportedCurrency' },
];

describe('B0-LRN-05 / B0-COM-05 currency allow-list (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function ownerWithAcademy(label: string) {
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
    const userId = signIn.body.user.id as string;
    const org = await seedOrganizationWithOwner(admin, userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, userId, 'owner');
    return { token: signIn.body.accessToken as string, academy };
  }

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('refuses switching an academy to an unsupported currency; EGP is accepted', async () => {
    const { token, academy } = await ownerWithAcademy('cur-academy');
    const refused = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}`)
      .set(auth(token))
      .send({ currency: 'USD' })
      .expect(400);
    expect(refused.body.error.violations).toEqual(UNSUPPORTED);
    expect(
      (await admin.academy.findUniqueOrThrow({ where: { id: academy.id } })).currency,
    ).toBe('EGP');

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}`)
      .set(auth(token))
      .send({ currency: 'EGP' })
      .expect(200);
  });

  it('lets a legacy academy re-save its stored currency, and its course prices are untouched', async () => {
    const { token, academy } = await ownerWithAcademy('cur-legacy');
    await admin.academy.update({ where: { id: academy.id }, data: { currency: 'USD' } });
    const course = await seedCourse(
      admin,
      academy.id,
      `cur-legacy-course-${Date.now()}`,
      {
        status: 'published',
        visibility: 'public',
        pricingType: 'paid',
      },
    );
    await admin.course.update({
      where: { id: course.id },
      data: { pricingAmountMinorUnits: 5000n, pricingCurrency: 'USD' },
    });

    // The settings form re-sends the stored value with any other change.
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}`)
      .set(auth(token))
      .send({ currency: 'USD', description: 'Updated description' })
      .expect(200);

    // Moving to EGP is allowed and does not rewrite the course's price.
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}`)
      .set(auth(token))
      .send({ currency: 'EGP' })
      .expect(200);
    const row = await admin.course.findUniqueOrThrow({ where: { id: course.id } });
    expect(row.pricingCurrency).toBe('USD');
    expect(row.pricingAmountMinorUnits).toBe(5000n);

    // The course itself can re-save its stored price currency…
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/courses/${course.id}`)
      .set(auth(token))
      .send({ pricing: { type: 'paid', amount: 60, currency: 'USD' } })
      .expect(200);
    // …but cannot move to another unsupported one.
    const refused = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/courses/${course.id}`)
      .set(auth(token))
      .send({ pricing: { type: 'paid', amount: 60, currency: 'SAR' } })
      .expect(400);
    expect(refused.body.error.violations).toEqual(UNSUPPORTED_PRICE);
  });

  it('refuses a new paid course priced in an unsupported currency', async () => {
    const { token, academy } = await ownerWithAcademy('cur-course');
    const refused = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses`)
      .set(auth(token))
      .send({
        title: 'Priced in dollars',
        slug: `cur-course-${Date.now()}`,
        visibility: 'public',
        pricing: { type: 'paid', amount: 10, currency: 'USD' },
      })
      .expect(400);
    expect(refused.body.error.violations).toEqual(UNSUPPORTED_PRICE);
    expect(await admin.course.count({ where: { academyId: academy.id } })).toBe(0);
  });
});
