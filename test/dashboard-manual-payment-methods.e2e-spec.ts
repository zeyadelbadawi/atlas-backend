/**
 * B0-CPY-15 — the dashboard tells the revenue card whether an academy in
 * scope has an ENABLED manual payment method, so an academy that already
 * collects by bank transfer, wallet or InstaPay is not told to "set up how
 * you collect payments". Scoped like every other dashboard figure: an
 * academy dashboard reads only that academy; the organization dashboard
 * reads all of its academies; a disabled method does not count.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedOrganizationWithOwner,
} from './utils/db-admin';

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

describe('Dashboard revenue — manual payment methods (e2e, B0-CPY-15)', () => {
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

  async function revenue(token: string, path: string) {
    const response = await request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return response.body.revenue as {
      tracked: boolean;
      paymentCollectionMode: string;
      manualPaymentMethodsEnabled: boolean;
    };
  }

  it('reports an enabled method only in the scope that holds it', async () => {
    const owner = await signUpAndSignIn(app, 'cpy15-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'cpy15-org');
    const academyA = await seedAcademy(admin, org.id, 'cpy15-a');
    const academyB = await seedAcademy(admin, org.id, 'cpy15-b');
    await seedAcademyMember(admin, academyA.id, owner.userId, 'owner');
    await seedAcademyMember(admin, academyB.id, owner.userId, 'owner');

    // Nothing configured yet: every scope says no.
    expect(
      (await revenue(owner.accessToken, `/academies/${academyA.id}/dashboard`))
        .manualPaymentMethodsEnabled,
    ).toBe(false);

    // A disabled method does not count.
    const method = await admin.academyPaymentMethod.create({
      data: {
        academyId: academyA.id,
        organizationId: org.id,
        type: 'manual_bank_transfer',
        enabled: false,
        instructions: { type: 'manual_bank_transfer' },
      },
    });
    expect(
      (await revenue(owner.accessToken, `/academies/${academyA.id}/dashboard`))
        .manualPaymentMethodsEnabled,
    ).toBe(false);

    await admin.academyPaymentMethod.update({
      where: { id: method.id },
      data: { enabled: true },
    });

    const a = await revenue(owner.accessToken, `/academies/${academyA.id}/dashboard`);
    expect(a.manualPaymentMethodsEnabled).toBe(true);
    // Manual revenue is still not summed here (B0-COM-02).
    expect(a.tracked).toBe(false);

    // The sibling academy has none of its own.
    expect(
      (await revenue(owner.accessToken, `/academies/${academyB.id}/dashboard`))
        .manualPaymentMethodsEnabled,
    ).toBe(false);

    // The organization dashboard spans both academies.
    expect(
      (await revenue(owner.accessToken, `/organizations/${org.id}/dashboard`))
        .manualPaymentMethodsEnabled,
    ).toBe(true);
  });

  it('never reads another organization’s methods', async () => {
    const ownerA = await signUpAndSignIn(app, 'cpy15-iso-a');
    const ownerB = await signUpAndSignIn(app, 'cpy15-iso-b');
    const orgA = await seedOrganizationWithOwner(admin, ownerA.userId, 'cpy15-iso-org-a');
    const orgB = await seedOrganizationWithOwner(admin, ownerB.userId, 'cpy15-iso-org-b');
    const academyA = await seedAcademy(admin, orgA.id, 'cpy15-iso-acad-a');
    await seedAcademy(admin, orgB.id, 'cpy15-iso-acad-b');
    await admin.academyPaymentMethod.create({
      data: {
        academyId: academyA.id,
        organizationId: orgA.id,
        type: 'manual_instapay',
        enabled: true,
        instructions: { type: 'manual_instapay' },
      },
    });

    expect(
      (await revenue(ownerB.accessToken, `/organizations/${orgB.id}/dashboard`))
        .manualPaymentMethodsEnabled,
    ).toBe(false);
  });
});
