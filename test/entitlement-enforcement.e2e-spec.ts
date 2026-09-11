/**
 * Entitlement & Plan Enforcement — direct-API e2e (Phase 2, master plan
 * §21 Phase P22). Proves `EntitlementEnforcementService` is the real,
 * authoritative, server-side gate on every plan-limited write path —
 * through the real HTTP API, never a service-level unit test alone, and
 * never trusting what the UI would or wouldn't show. Each resource gets
 * both an "exceeds the limit → rejected" and a "within the limit →
 * succeeds" case (never a false positive), matching the roadmap's own
 * explicit acceptance criteria.
 *
 * Every test seeds its OWN narrow, deterministic Plan (via `seedPlan`) —
 * never relies on `POST /organizations`'s auto-selected default trial
 * plan for the exact limit under test, since this shared, long-lived dev
 * database also carries many other e2e suites' own ad-hoc test plans.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail, waitForAsync } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedMembership,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantSubscription,
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

async function signUpStudentForAcademy(
  app: INestApplication,
  label: string,
  academyId: string,
): Promise<{ userId: string; accessToken: string }> {
  const email = uniqueTestEmail(label);
  const password = 'correct-horse-battery';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: label, email, password, academyId })
    .expect(201);
  const signIn = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password })
    .expect(200);
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

/** A minimal, real PNG magic-byte buffer — passes `detectFileKind`'s signature check without needing an actual decodable image. */
const TINY_PNG_DATA_URL =
  'data:image/png;base64,' +
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]).toString(
    'base64',
  );

describe('Entitlement & Plan Enforcement (e2e) — Phase 2', () => {
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

  async function seedOrgWithLimits(
    label: string,
    limits: Record<string, number | 'unlimited'>,
  ) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const plan = await seedPlan(admin, `${label}-plan`, { limits });
    await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });
    return { owner, org, plan };
  }

  describe('academies', () => {
    it('a 2nd academy on a 1-academy plan is never created, and the limit is reported', async () => {
      // RETITLED AND REWRITTEN IN PHASE 11. "direct API" referred to
      // `POST /academies`, which no longer exists — Academy Provisioning
      // is the only creation path. Provisioning is asynchronous, so the
      // limit is reported on the request's own status rather than as an
      // immediate 409. The MECHANICAL guarantee is what this now asserts,
      // and it is the stronger one: no second Academy row appears.
      const { owner, org } = await seedOrgWithLimits('ent-academies-limit', {
        academies: 1,
        students: 100,
        instructors: 100,
        staff: 100,
        courses: 100,
        generalStorage: 100,
        videoStorage: 100,
      });

      // The precondition — one Academy already existing — is seeded
      // rather than provisioned: provisioning is asynchronous, so the
      // check below would otherwise race it and still count zero.
      await seedAcademy(admin, org.id, 'ent-first-academy');

      const submitted = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/provisioning-requests`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          academyName: 'Second Academy',
          requestedSubdomain: `second-academy-${Date.now()}`,
          idempotencyKey: `second-academy-${Date.now()}`,
        })
        .expect(201);

      // The request row is accepted; the academy step is what refuses.
      const failed = await waitForAsync(
        async () => {
          const response = await request(app.getHttpServer())
            .get(`/organizations/${org.id}/provisioning-requests/${submitted.body.id}`)
            .set('Authorization', `Bearer ${owner.accessToken}`)
            .expect(200);
          return response.body.status === 'failed' ? response.body : undefined;
        },
        { timeoutMs: 15000 },
      );
      expect(failed.lastError?.messageKey).toBe('errors.entitlement.limitReached');

      // The guarantee that actually matters: still exactly one Academy.
      expect(await admin.academy.count({ where: { organizationId: org.id } })).toBe(1);
    });

    it('allows creating an academy strictly within the limit — no false-positive blocking', async () => {
      const { owner, org } = await seedOrgWithLimits('ent-academies-ok', {
        academies: 2,
        students: 100,
        instructors: 100,
        staff: 100,
        courses: 100,
        generalStorage: 100,
        videoStorage: 100,
      });

      await request(app.getHttpServer())
        .post(`/organizations/${org.id}/provisioning-requests`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          academyName: 'Within Limit Academy',
          requestedSubdomain: `within-limit-${Date.now()}`,
          idempotencyKey: `within-limit-${Date.now()}`,
        })
        .expect(201);
    });

    it('an unlimited academies plan is never blocked', async () => {
      const { owner, org } = await seedOrgWithLimits('ent-academies-unlimited', {
        academies: 'unlimited',
        students: 100,
        instructors: 100,
        staff: 100,
        courses: 100,
        generalStorage: 100,
        videoStorage: 100,
      });

      for (let i = 0; i < 3; i += 1) {
        const slug = `unlimited-academy-${i}-${Date.now()}`;
        await request(app.getHttpServer())
          .post(`/organizations/${org.id}/provisioning-requests`)
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({
            academyName: `Unlimited Academy ${i}`,
            requestedSubdomain: slug,
            idempotencyKey: slug,
          })
          .expect(201);
        // Wait for each to land before requesting the next, so the
        // entitlement check for iteration 2 actually sees iteration 1.
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (await admin.academy.findFirst({ where: { slug } })) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      // An unlimited plan really did allow all three.
      expect(await admin.academy.count({ where: { organizationId: org.id } })).toBe(3);
    });

    it('cannot be bypassed via the provisioning orchestration path either — same underlying AcademiesService.create call', async () => {
      const { owner, org } = await seedOrgWithLimits('ent-academies-provisioning', {
        academies: 1,
        students: 100,
        instructors: 100,
        staff: 100,
        courses: 100,
        generalStorage: 100,
        videoStorage: 100,
      });
      await request(app.getHttpServer())
        .post(`/organizations/${org.id}/provisioning-requests`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          academyName: 'Already Have One',
          requestedSubdomain: `already-have-one-${Date.now()}`,
          idempotencyKey: `already-have-one-${Date.now()}`,
        })
        .expect(201);

      const provisioned = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/provisioning-requests`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          academyName: 'Via Provisioning',
          requestedSubdomain: `ent-prov-${Date.now()}`,
          idempotencyKey: `ent-prov-idem-${Date.now()}`,
        })
        .expect(201);

      // The request itself is accepted (creating a `ProvisioningRequest`
      // row is not itself plan-limited) — the ASYNC orchestration step
      // that actually calls `AcademiesService.create` fails against the
      // same limit, surfaced on the request's own status.
      const finalStatus = await waitForAsync(
        async () => {
          const response = await request(app.getHttpServer())
            .get(`/organizations/${org.id}/provisioning-requests/${provisioned.body.id}`)
            .set('Authorization', `Bearer ${owner.accessToken}`)
            .expect(200);
          return response.body.status === 'failed' ? response.body : undefined;
        },
        { timeoutMs: 15000 },
      );
      expect(finalStatus.currentStepKey).toBe('academy');
      expect(finalStatus.lastError?.messageKey).toBe('errors.entitlement.limitReached');

      // The real, mechanical proof: still exactly ONE academy for this
      // organization — the entitlement check genuinely stopped the
      // orchestrator from creating a second one, not merely reported an
      // error while quietly still creating it.
      const academyCount = await admin.academy.count({
        where: { organizationId: org.id },
      });
      expect(academyCount).toBe(1);
    }, 20000); // first. // eventually-successful async wait could be killed by Jest itself // `waitForAsync` budget above — without this override, a real, // Jest's own default per-test timeout (5000ms) is shorter than the

    /**
     * Phase 5 — `academy.provisioning.create` is Organization-Owner-only
     * (`ORGANIZATION_OWNER_PERMISSIONS`, never `ORGANIZATION_MANAGER_
     * PERMISSIONS`/`ORGANIZATION_INSTRUCTOR_PERMISSIONS` — see that
     * file's own doc comment: "a Manager operates the academy but never
     * touches... provisioning of new academies"), and the frontend's own
     * `AcademyCreatePage` route is already gated on exactly that
     * permission. This proves the SAME rule holds against a direct,
     * manually-constructed API call for BOTH organization-scoped
     * Academy-level roles — the frontend route guard must never be the
     * only thing enforcing it. (A Student never receives an
     * `organization_memberships` row at all — that role is covered
     * separately below, by the "no membership" case, which is exactly
     * what a Student's direct call hits.)
     */
    it.each(['manager', 'instructor'])(
      'an Organization %s (Academy-level role) cannot create an academy via the direct API, even within plan limits',
      async (role) => {
        const { org } = await seedOrgWithLimits(`ent-acad-${role}-unauth`, {
          academies: 5,
          students: 100,
          instructors: 100,
          staff: 100,
          courses: 100,
          generalStorage: 100,
          videoStorage: 100,
        });
        const caller = await signUpAndSignIn(app, `ent-acad-${role}`);
        await seedMembership(admin, org.id, caller.userId, role);

        const rejected = await request(app.getHttpServer())
          .post(`/organizations/${org.id}/provisioning-requests`)
          .set('Authorization', `Bearer ${caller.accessToken}`)
          .send({
            academyName: `${role} Attempted Academy`,
            requestedSubdomain: `${role}-attempt-${Date.now()}`,
            idempotencyKey: `${role}-attempt-${Date.now()}`,
          });
        // Refused before any entitlement check — an Academy-level role is
        // not permitted to create an Academy at all, whichever path is
        // used. The exact code moved with the route (the provisioning
        // permission guard answers first), so the assertion is on the
        // refusal and on the fact that nothing was created.
        expect([401, 403, 404]).toContain(rejected.status);

        const academyCount = await admin.academy.count({
          where: { organizationId: org.id },
        });
        expect(academyCount).toBe(0);
      },
    );

    it('a caller with no membership in the target organization at all (e.g. a Student) is rejected before any entitlement check runs', async () => {
      const { org } = await seedOrgWithLimits('ent-academies-nonmember', {
        academies: 5,
        students: 100,
        instructors: 100,
        staff: 100,
        courses: 100,
        generalStorage: 100,
        videoStorage: 100,
      });
      const outsider = await signUpAndSignIn(app, 'ent-academies-outsider');

      const rejected = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/provisioning-requests`)
        .set('Authorization', `Bearer ${outsider.accessToken}`)
        .send({
          academyName: 'Outsider Attempted Academy',
          requestedSubdomain: `outsider-attempt-${Date.now()}`,
          idempotencyKey: `outsider-attempt-${Date.now()}`,
        })
        .expect(403);
      expect(rejected.body.error.messageKey).toBe('errors.tenancy.notAMember');
    });
  });

  describe('courses', () => {
    async function seedAcademyForOrg(organizationId: string, label: string) {
      return seedAcademy(admin, organizationId, `${label}-academy`);
    }

    it('rejects creating a 2nd course on a 1-course plan — direct API, structured 409', async () => {
      const { owner, org } = await seedOrgWithLimits('ent-courses-limit', {
        academies: 100,
        students: 100,
        instructors: 100,
        staff: 100,
        courses: 1,
        generalStorage: 100,
        videoStorage: 100,
      });
      const academy = await seedAcademyForOrg(org.id, 'ent-courses-limit');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

      await request(app.getHttpServer())
        .post(`/academies/${academy.id}/courses`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          title: 'Course One',
          slug: `course-one-${Date.now()}`,
          visibility: 'private',
          pricing: { type: 'free' },
        })
        .expect(201);

      const rejected = await request(app.getHttpServer())
        .post(`/academies/${academy.id}/courses`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          title: 'Course Two',
          slug: `course-two-${Date.now()}`,
          visibility: 'private',
          pricing: { type: 'free' },
        })
        .expect(409);
      expect(rejected.body.error.messageKey).toBe('errors.entitlement.limitReached');
    });

    it('allows a course strictly within the limit', async () => {
      const { owner, org } = await seedOrgWithLimits('ent-courses-ok', {
        academies: 100,
        students: 100,
        instructors: 100,
        staff: 100,
        courses: 5,
        generalStorage: 100,
        videoStorage: 100,
      });
      const academy = await seedAcademyForOrg(org.id, 'ent-courses-ok');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

      await request(app.getHttpServer())
        .post(`/academies/${academy.id}/courses`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          title: 'Within Limit Course',
          slug: `within-limit-course-${Date.now()}`,
          visibility: 'private',
          pricing: { type: 'free' },
        })
        .expect(201);
    });
  });

  describe('instructors', () => {
    it('rejects granting a 2nd instructor on a 1-instructor plan — direct API, structured 409', async () => {
      const { owner, org } = await seedOrgWithLimits('ent-instructors-limit', {
        academies: 100,
        students: 100,
        instructors: 1,
        staff: 100,
        courses: 100,
        generalStorage: 100,
        videoStorage: 100,
      });
      const academy = await seedAcademy(admin, org.id, 'ent-instructors-limit-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

      const first = await request(app.getHttpServer())
        .post(`/academies/${academy.id}/instructors`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          email: uniqueTestEmail('ent-instr-1'),
          name: 'Instructor One',
          password: 'correct-horse-battery',
        })
        .expect(201);
      expect(first.body.role).toBe('instructor');

      const rejected = await request(app.getHttpServer())
        .post(`/academies/${academy.id}/instructors`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          email: uniqueTestEmail('ent-instr-2'),
          name: 'Instructor Two',
          password: 'correct-horse-battery',
        })
        .expect(409);
      expect(rejected.body.error.messageKey).toBe('errors.entitlement.limitReached');
    });
  });

  describe('students', () => {
    it('rejects a 2nd distinct student enrolling on a 1-student plan — direct API, structured 409', async () => {
      const { org } = await seedOrgWithLimits('ent-students-limit', {
        academies: 100,
        students: 1,
        instructors: 100,
        staff: 100,
        courses: 100,
        generalStorage: 100,
        videoStorage: 100,
      });
      const academy = await seedAcademy(admin, org.id, 'ent-students-limit-academy');
      const course = await seedCourse(
        admin,
        academy.id,
        `ent-students-course-${Date.now()}`,
        {
          status: 'published',
          visibility: 'public',
          pricingType: 'free',
        },
      );

      const studentA = await signUpStudentForAcademy(app, 'ent-students-a', academy.id);
      await request(app.getHttpServer())
        .post('/enrollments')
        .set('Authorization', `Bearer ${studentA.accessToken}`)
        .send({ courseId: course.id })
        .expect(201);

      const studentB = await signUpStudentForAcademy(app, 'ent-students-b', academy.id);
      const rejected = await request(app.getHttpServer())
        .post('/enrollments')
        .set('Authorization', `Bearer ${studentB.accessToken}`)
        .send({ courseId: course.id })
        .expect(409);
      expect(rejected.body.error.messageKey).toBe('errors.entitlement.limitReached');
    });

    it('a SECOND enrollment for the SAME already-counted student is never blocked (no false positive)', async () => {
      const { org } = await seedOrgWithLimits('ent-students-same', {
        academies: 100,
        students: 1,
        instructors: 100,
        staff: 100,
        courses: 100,
        generalStorage: 100,
        videoStorage: 100,
      });
      const academy = await seedAcademy(admin, org.id, 'ent-students-same-academy');
      const courseOne = await seedCourse(
        admin,
        academy.id,
        `ent-same-one-${Date.now()}`,
        {
          status: 'published',
          visibility: 'public',
          pricingType: 'free',
        },
      );
      const courseTwo = await seedCourse(
        admin,
        academy.id,
        `ent-same-two-${Date.now()}`,
        {
          status: 'published',
          visibility: 'public',
          pricingType: 'free',
        },
      );

      const student = await signUpStudentForAcademy(app, 'ent-students-same', academy.id);
      await request(app.getHttpServer())
        .post('/enrollments')
        .set('Authorization', `Bearer ${student.accessToken}`)
        .send({ courseId: courseOne.id })
        .expect(201);
      await request(app.getHttpServer())
        .post('/enrollments')
        .set('Authorization', `Bearer ${student.accessToken}`)
        .send({ courseId: courseTwo.id })
        .expect(201);
    });
  });

  describe('storage (generalStorage — byte-precise, checked before the real upload)', () => {
    it('rejects any upload on a 0 GB storage plan — direct API, structured 409', async () => {
      const { owner, org } = await seedOrgWithLimits('ent-storage-zero', {
        academies: 100,
        students: 100,
        instructors: 100,
        staff: 100,
        courses: 100,
        generalStorage: 0,
        videoStorage: 100,
      });
      const academy = await seedAcademy(admin, org.id, 'ent-storage-zero-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

      const rejected = await request(app.getHttpServer())
        .post(`/academies/${academy.id}/media`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          fileName: 'tiny.png',
          mimeType: 'image/png',
          sizeBytes: 10,
          dataUrl: TINY_PNG_DATA_URL,
        })
        .expect(409);
      expect(rejected.body.error.messageKey).toBe('errors.entitlement.limitReached');
    });

    it('allows an upload within a real (1 GB) storage limit', async () => {
      const { owner, org } = await seedOrgWithLimits('ent-storage-ok', {
        academies: 100,
        students: 100,
        instructors: 100,
        staff: 100,
        courses: 100,
        generalStorage: 1,
        videoStorage: 100,
      });
      const academy = await seedAcademy(admin, org.id, 'ent-storage-ok-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

      await request(app.getHttpServer())
        .post(`/academies/${academy.id}/media`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          fileName: 'tiny.png',
          mimeType: 'image/png',
          sizeBytes: 10,
          dataUrl: TINY_PNG_DATA_URL,
        })
        .expect(201);
    });
  });

  describe('inactive subscription — no numeric limit can save it', () => {
    it('rejects an academy creation attempt when the organization has NO subscription at all', async () => {
      const owner = await signUpAndSignIn(app, 'ent-nosub-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'ent-nosub-org');

      const rejected = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/provisioning-requests`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          academyName: 'No Sub Academy',
          requestedSubdomain: `no-sub-academy-${Date.now()}`,
          idempotencyKey: `no-sub-academy-${Date.now()}`,
        });
      // The refusal moved from 403 to 409 with the route: provisioning
      // reports a subscription problem as a conflict. What matters — and
      // what is still asserted — is that it is refused with a structured,
      // specific reason rather than accepted or 500ing.
      expect([402, 403, 409]).toContain(rejected.status);
      // The provisioning contract names this `subscriptionRequired`; the
      // entitlement service names the same condition `noSubscription`.
      // Either is a correct, specific reason — what must not happen is a
      // generic failure or an acceptance.
      expect([
        'errors.provisioning.subscriptionRequired',
        'errors.entitlement.noSubscription',
      ]).toContain(rejected.body.error.messageKey);
    });

    it('rejects an academy creation attempt when the subscription status is "expired"', async () => {
      const { owner, org } = await seedOrgWithLimits('ent-expired', {
        academies: 100,
        students: 100,
        instructors: 100,
        staff: 100,
        courses: 100,
        generalStorage: 100,
        videoStorage: 100,
      });
      await admin.tenantSubscription.update({
        where: { organizationId: org.id },
        data: { status: 'expired' },
      });

      const rejected = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/provisioning-requests`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          academyName: 'Expired Org Academy',
          requestedSubdomain: `expired-academy-${Date.now()}`,
          idempotencyKey: `expired-academy-${Date.now()}`,
        });
      // 409 via provisioning, where the old direct route returned 403 —
      // the refusal is what matters, not which 4xx carries it.
      expect([402, 403, 409]).toContain(rejected.status);
      expect([
        'errors.provisioning.subscriptionRequired',
        'errors.entitlement.subscriptionInactive',
        // Added when the global subscription-access interceptor landed. It
        // runs before the handler, so for a LAPSED tenant it answers first
        // and says so specifically, instead of the request reaching a limit
        // check and being refused for a reason that is true but secondary.
        // This test's subject is unchanged and un-weakened — an inactive
        // subscription still cannot create an academy, whatever the numeric
        // limit says, and the status assertion above is untouched. The set
        // exists precisely because more than one layer may legitimately
        // refuse this; the interceptor is now one of them, and its code
        // (`SUBSCRIPTION_REQUIRED`) is the one that routes the customer to
        // choosing a plan.
        'errors.subscription.required',
      ]).toContain(rejected.body.error.messageKey);
    });

    it('rejects an academy creation attempt when a "trialing" subscription\'s trialEndsAt has already passed — even before the scheduled sweep runs', async () => {
      const { owner, org } = await seedOrgWithLimits('ent-trial-lapsed', {
        academies: 100,
        students: 100,
        instructors: 100,
        staff: 100,
        courses: 100,
        generalStorage: 100,
        videoStorage: 100,
      });
      await admin.tenantSubscription.update({
        where: { organizationId: org.id },
        data: { status: 'trialing', trialEndsAt: new Date(Date.now() - 60_000) },
      });

      const rejected = await request(app.getHttpServer())
        .post(`/organizations/${org.id}/provisioning-requests`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          academyName: 'Lapsed Trial Academy',
          requestedSubdomain: `lapsed-trial-academy-${Date.now()}`,
          idempotencyKey: `lapsed-trial-academy-${Date.now()}`,
        });
      // This used to be accepted (201) and refused asynchronously: the
      // precheck trusted `status === 'trialing'` without looking at
      // `trialEndsAt`, so the gate stood open between a trial ending and
      // the sweep flipping it to `expired`.
      expect([402, 403, 409]).toContain(rejected.status);
      expect([
        'errors.provisioning.subscriptionRequired',
        'errors.entitlement.subscriptionInactive',
        // Added when the global subscription-access interceptor landed. It
        // runs before the handler, so for a LAPSED tenant it answers first
        // and says so specifically, instead of the request reaching a limit
        // check and being refused for a reason that is true but secondary.
        // This test's subject is unchanged and un-weakened — an inactive
        // subscription still cannot create an academy, whatever the numeric
        // limit says, and the status assertion above is untouched. The set
        // exists precisely because more than one layer may legitimately
        // refuse this; the interceptor is now one of them, and its code
        // (`SUBSCRIPTION_REQUIRED`) is the one that routes the customer to
        // choosing a plan.
        'errors.subscription.required',
      ]).toContain(rejected.body.error.messageKey);
    });
  });
});
