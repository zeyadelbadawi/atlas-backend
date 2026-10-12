/**
 * B0-SEC-03 — teaching staff must not read academy-wide learner analytics
 * or revenue totals.
 *
 *   - `GET /academies/:id/student-analytics` covers every course of the
 *     academy, so it is for the managing tier (owner/administrator/manager,
 *     and the organization owner). An instructor or staff member is refused.
 *   - `GET /academies/:id/dashboard` reports revenue totals only to the
 *     organization owner. Any other member gets `tracked: false` and no
 *     totals, the same answer as an organization that does not use Atlas
 *     Payments.
 *
 * Exercised over HTTP against real Postgres, like the Phase 8/9 suites.
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
  seedOrganizationWithOwner,
  seedPaymentCollectionMode,
} from './utils/db-admin';
import {
  ORGANIZATION_INSTRUCTOR_PERMISSIONS,
  ORGANIZATION_MANAGER_PERMISSIONS,
} from '../src/tenancy/constants/organization-permissions.constants';

jest.setTimeout(30000);

async function signUpAndSignIn(app: INestApplication, label: string) {
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
    accessToken: signIn.body.accessToken as string,
  };
}

describe('Staff API scope: analytics and revenue (e2e) — B0-SEC-03', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let owner: { userId: string; accessToken: string };
  let manager: { userId: string; accessToken: string };
  let instructor: { userId: string; accessToken: string };
  let staff: { userId: string; accessToken: string };
  let orgId: string;
  let academyId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;

    owner = await signUpAndSignIn(app, 'sec03-owner');
    manager = await signUpAndSignIn(app, 'sec03-manager');
    instructor = await signUpAndSignIn(app, 'sec03-instructor');
    staff = await signUpAndSignIn(app, 'sec03-staff');

    const org = await seedOrganizationWithOwner(admin, owner.userId, 'sec03-org');
    orgId = org.id;
    await seedActiveSubscriptionForOrg(admin, orgId, 'sec03');
    const academy = await seedAcademy(admin, orgId, 'sec03-academy');
    academyId = academy.id;
    await seedAcademyMember(admin, academyId, owner.userId, 'owner');

    await admin.organizationMembership.createMany({
      data: [
        {
          organizationId: orgId,
          userId: manager.userId,
          role: 'manager',
          permissions: [...ORGANIZATION_MANAGER_PERMISSIONS],
        },
        {
          organizationId: orgId,
          userId: instructor.userId,
          role: 'instructor',
          permissions: [...ORGANIZATION_INSTRUCTOR_PERMISSIONS],
        },
        {
          organizationId: orgId,
          userId: staff.userId,
          role: 'instructor',
          permissions: [...ORGANIZATION_INSTRUCTOR_PERMISSIONS],
        },
      ],
    });
    await seedAcademyMember(admin, academyId, manager.userId, 'manager');
    await seedAcademyMember(admin, academyId, instructor.userId, 'instructor');
    await seedAcademyMember(admin, academyId, staff.userId, 'staff');

    // The one mode in which the dashboard reports revenue at all.
    await seedPaymentCollectionMode(admin, orgId, 'atlas_payments');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const get = (path: string, token: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${token}`);

  describe('academy student analytics', () => {
    it('refuses an instructor', async () => {
      await get(
        `/academies/${academyId}/student-analytics`,
        instructor.accessToken,
      ).expect(403);
    });

    it('refuses a staff member', async () => {
      await get(`/academies/${academyId}/student-analytics`, staff.accessToken).expect(
        403,
      );
    });

    it('still serves the academy manager and the organization owner', async () => {
      await get(`/academies/${academyId}/student-analytics`, manager.accessToken).expect(
        200,
      );
      await get(`/academies/${academyId}/student-analytics`, owner.accessToken).expect(
        200,
      );
    });
  });

  describe('academy dashboard revenue', () => {
    it('reports revenue to the organization owner', async () => {
      const res = await get(
        `/academies/${academyId}/dashboard`,
        owner.accessToken,
      ).expect(200);
      expect(res.body.revenue.tracked).toBe(true);
    });

    it.each([
      ['manager', () => manager],
      ['instructor', () => instructor],
    ] as const)('gives the %s no revenue totals', async (_role, who) => {
      const res = await get(`/academies/${academyId}/dashboard`, who().accessToken);
      // An instructor may be refused the dashboard outright; if it is
      // served, it must carry no revenue figures.
      if (res.status === 200) {
        expect(res.body.revenue.tracked).toBe(false);
        expect(res.body.revenue.totals).toEqual([]);
      } else {
        expect(res.status).toBe(403);
      }
    });
  });
});
