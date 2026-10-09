/**
 * Provisioning requests are the organization OWNER's — every route, not
 * only create (real Postgres, RLS enforced).
 *
 * `createRequest` and `attachLogo` already refused anyone but the
 * organization owner (`assertCanCreateAcademy`), but list/get/retry/cancel
 * relied on `OrganizationMembershipGuard` alone — so an organization
 * Manager or Instructor could read the organization's academy pipeline,
 * re-run academy creation, or cancel the owner's in-flight request. The
 * frontend's provisioning screens were already gated on the owner-only
 * `academy.provisioning.view`; the API now agrees.
 *
 * The request is seeded directly (never enqueued), so it stays
 * deterministically non-terminal: the system under test is authorization,
 * not step execution — the same precedent `provisioning.e2e-spec.ts`'s own
 * cancellation test documents.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import {
  ORGANIZATION_INSTRUCTOR_PERMISSIONS,
  ORGANIZATION_MANAGER_PERMISSIONS,
} from '../src/tenancy/constants/organization-permissions.constants';

interface Caller {
  readonly userId: string;
  readonly accessToken: string;
}

async function signUpAndSignIn(app: INestApplication, label: string): Promise<Caller> {
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

describe('Provisioning requests — owner only (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;

  let owner: Caller;
  let manager: Caller;
  let instructor: Caller;
  let organizationId: string;

  const http = () => request(app.getHttpServer());
  const bearer = (caller: Caller) => ({ Authorization: `Bearer ${caller.accessToken}` });

  async function seedRequest(label: string) {
    const subdomain = `pown-${label}-${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    return admin.provisioningRequest.create({
      data: {
        organizationId,
        requestedByUserId: owner.userId,
        requestedAcademyName: `Owner Only ${label}`,
        requestedSubdomain: subdomain,
        idempotencyKey: `idem-${subdomain}`,
      },
    });
  }

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    await testApp.flushRateLimitKeys();
    admin = createAdminPrisma();

    owner = await signUpAndSignIn(app, 'pown-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'pown-org');
    organizationId = org.id;
    await seedActiveSubscriptionForOrg(admin, org.id, 'pown-sub');

    manager = await signUpAndSignIn(app, 'pown-manager');
    await admin.organizationMembership.create({
      data: {
        organizationId,
        userId: manager.userId,
        role: 'manager',
        permissions: [...ORGANIZATION_MANAGER_PERMISSIONS],
      },
    });
    instructor = await signUpAndSignIn(app, 'pown-instructor');
    await admin.organizationMembership.create({
      data: {
        organizationId,
        userId: instructor.userId,
        role: 'instructor',
        permissions: [...ORGANIZATION_INSTRUCTOR_PERMISSIONS],
      },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  it('a Manager and an Instructor cannot list, read, retry or cancel a provisioning request (403), and the request is untouched', async () => {
    const seeded = await seedRequest('refused');
    const base = `/organizations/${organizationId}/provisioning-requests`;

    for (const caller of [manager, instructor]) {
      await http().get(base).set(bearer(caller)).expect(403);
      await http().get(`${base}/${seeded.id}`).set(bearer(caller)).expect(403);
      await http().post(`${base}/${seeded.id}/retry`).set(bearer(caller)).expect(403);
      await http().post(`${base}/${seeded.id}/cancel`).set(bearer(caller)).expect(403);
    }

    const row = await admin.provisioningRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(row.status).toBe(seeded.status);
    expect(row.attemptCount).toBe(seeded.attemptCount);
  });

  it('the refusal does not depend on the request existing (no oracle for request ids)', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    const base = `/organizations/${organizationId}/provisioning-requests`;
    await http().get(`${base}/${missing}`).set(bearer(manager)).expect(403);
    await http().post(`${base}/${missing}/cancel`).set(bearer(manager)).expect(403);
  });

  it('the organization owner still lists, reads and cancels', async () => {
    const seeded = await seedRequest('owner');
    const base = `/organizations/${organizationId}/provisioning-requests`;

    const list = await http().get(base).set(bearer(owner)).expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(seeded.id);
    await http().get(`${base}/${seeded.id}`).set(bearer(owner)).expect(200);
    await http().post(`${base}/${seeded.id}/cancel`).set(bearer(owner)).expect(201);
    const row = await admin.provisioningRequest.findUniqueOrThrow({
      where: { id: seeded.id },
    });
    expect(row.status).toBe('cancelled');
  });
});
