/**
 * Phase 8 (Support, Audit & Dashboards) security/tenancy suite —
 * P8-TENANT-001..011, extending the permanent per-phase tenant-isolation
 * suite (`tenant-isolation.e2e-spec.ts`, `courses-tenant-isolation.
 * e2e-spec.ts`, ... — one file per phase, same pattern, same helpers).
 *
 * Exercised through the real HTTP surface against real Postgres/Redis, no
 * mocks — every scenario below is the roadmap's own explicitly required
 * test, in its stated order:
 *
 *   001  Dashboard data cannot cross Academy boundaries (Manager scope)
 *   002  Dashboard data cannot cross Organization boundaries
 *   003  Recent activity cannot cross Academy boundaries
 *   004  Client Owner sees their whole organization, and only theirs
 *   005  A direct API call with another tenant's id is refused (no
 *        frontend involved — the bypass-resistance proof)
 *   006  A support case cannot be created against another tenant
 *   007  A support case cannot be READ by another tenant
 *   008  Audit entries record the correct actor, role and academy
 *   009  Course/Instructor/Learning mutations are actually audited
 *   010  The provisioning auto-ticket fires at exactly the threshold
 *   011  ...and never opens a second ticket for the same failure episode
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';
import { ProvisioningOrchestratorService } from '../src/provisioning/services/provisioning-orchestrator.service';
import {
  PROVISIONING_AUTO_SUPPORT_CASE_FAILURE_THRESHOLD,
  PROVISIONING_STEP_ORDER,
} from '../src/provisioning/dto/provisioning.constants';
import { ORGANIZATION_MANAGER_PERMISSIONS } from '../src/tenancy/constants/organization-permissions.constants';

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

async function seedManagedAcademy(
  admin: PrismaClient,
  organizationId: string,
  ownerUserId: string,
  label: string,
) {
  const academy = await seedAcademy(admin, organizationId, label);
  await seedAcademyMember(admin, academy.id, ownerUserId, 'owner');
  return academy;
}

describe('Phase 8 support/audit/dashboard tenant isolation (e2e) — P8-TENANT-001..011', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let orchestrator: ProvisioningOrchestratorService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    orchestrator = app.get(ProvisioningOrchestratorService);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  // -------------------------------------------------------------------
  // Dashboard scoping
  // -------------------------------------------------------------------

  it('P8-TENANT-001: a Manager’s Academy dashboard never counts a sibling Academy’s data', async () => {
    const owner = await signUpAndSignIn(app, 'p8t001-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p8t001-org');
    const academyA = await seedManagedAcademy(admin, org.id, owner.userId, 'p8t001-a');
    const academyB = await seedManagedAcademy(admin, org.id, owner.userId, 'p8t001-b');

    // Two courses in A, five in B — both under the SAME organization, so
    // organization-level RLS alone would happily return all seven.
    await seedCourse(admin, academyA.id, 'p8t001-a-course-1');
    await seedCourse(admin, academyA.id, 'p8t001-a-course-2');
    for (let index = 0; index < 5; index += 1) {
      await seedCourse(admin, academyB.id, `p8t001-b-course-${index}`);
    }

    const response = await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/dashboard`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(response.body.scope.type).toBe('academy');
    expect(response.body.scope.academyId).toBe(academyA.id);
    // Exactly A's two — never A+B's seven.
    expect(response.body.counts.courses).toBe(2);
    // An academy-scoped dashboard reports itself, never the org total of 2.
    expect(response.body.counts.academies).toBe(1);
  });

  it('P8-TENANT-002: an Organization’s dashboard never counts another Organization’s data', async () => {
    const userA = await signUpAndSignIn(app, 'p8t002-userA');
    const userB = await signUpAndSignIn(app, 'p8t002-userB');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'p8t002-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p8t002-org2');
    const academy1 = await seedManagedAcademy(admin, org1.id, userA.userId, 'p8t002-a1');
    const academy2 = await seedManagedAcademy(admin, org2.id, userB.userId, 'p8t002-a2');

    await seedCourse(admin, academy1.id, 'p8t002-org1-course');
    await seedCourse(admin, academy2.id, 'p8t002-org2-course-1');
    await seedCourse(admin, academy2.id, 'p8t002-org2-course-2');
    await seedAcademyStudent(admin, academy2.id, userB.userId);

    const response = await request(app.getHttpServer())
      .get(`/organizations/${org1.id}/dashboard`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    expect(response.body.counts.courses).toBe(1);
    expect(response.body.counts.academies).toBe(1);
    expect(response.body.counts.students).toBe(0);
  });

  it('P8-TENANT-003: recent activity never leaks a sibling Academy’s audit entries', async () => {
    const owner = await signUpAndSignIn(app, 'p8t003-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p8t003-org');
    // Course creation runs a real, live plan-limit check (Phase 2), so a
    // real active subscription is part of the fixture — not a workaround.
    await seedActiveSubscriptionForOrg(admin, org.id, 'p8t003');
    const academyA = await seedManagedAcademy(admin, org.id, owner.userId, 'p8t003-a');
    const academyB = await seedManagedAcademy(admin, org.id, owner.userId, 'p8t003-b');

    // Two real, audited course creations — one in each academy.
    await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'P8T003 A',
        slug: `p8t003-a-${Date.now()}`,
        visibility: 'private',
        pricing: { type: 'free' },
      })
      .expect(201);
    const courseB = await request(app.getHttpServer())
      .post(`/academies/${academyB.id}/courses`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'P8T003 B SECRET',
        slug: `p8t003-b-${Date.now()}`,
        visibility: 'private',
        pricing: { type: 'free' },
      })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/dashboard`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const activity = response.body.recentActivity as {
      academyId?: string;
      targetId: string;
    }[];
    expect(activity.length).toBeGreaterThan(0);
    // Every row belongs to academy A — and B's course is nowhere in it.
    expect(activity.every((item) => item.academyId === academyA.id)).toBe(true);
    expect(activity.some((item) => item.targetId === courseB.body.id)).toBe(false);
  });

  it('P8-TENANT-004: a Client Owner’s dashboard spans every Academy they own, and only those', async () => {
    const owner = await signUpAndSignIn(app, 'p8t004-owner');
    const stranger = await signUpAndSignIn(app, 'p8t004-stranger');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p8t004-org');
    const otherOrg = await seedOrganizationWithOwner(
      admin,
      stranger.userId,
      'p8t004-other',
    );
    const academyA = await seedManagedAcademy(admin, org.id, owner.userId, 'p8t004-a');
    const academyB = await seedManagedAcademy(admin, org.id, owner.userId, 'p8t004-b');
    const foreign = await seedManagedAcademy(
      admin,
      otherOrg.id,
      stranger.userId,
      'p8t004-foreign',
    );

    await seedCourse(admin, academyA.id, 'p8t004-a-course');
    await seedCourse(admin, academyB.id, 'p8t004-b-course');
    await seedCourse(admin, foreign.id, 'p8t004-foreign-course');

    const response = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/dashboard`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(response.body.scope.type).toBe('organization');
    // Both of their own academies' courses — never the third one.
    expect(response.body.counts.courses).toBe(2);
    expect(response.body.counts.academies).toBe(2);
  });

  it('P8-TENANT-004b: an Academy Manager is refused the ORGANIZATION dashboard, so a sibling Academy never leaks', async () => {
    const owner = await signUpAndSignIn(app, 'p8t004b-owner');
    const manager = await signUpAndSignIn(app, 'p8t004b-manager');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p8t004b-org');
    const academyA = await seedManagedAcademy(admin, org.id, owner.userId, 'p8t004b-a');
    const academyB = await seedManagedAcademy(admin, org.id, owner.userId, 'p8t004b-b');

    // A real Manager of academy A only — with the real manager permission
    // set, exactly as `AcademiesService.addManager` grants it.
    await admin.organizationMembership.create({
      data: {
        organizationId: org.id,
        userId: manager.userId,
        role: 'manager',
        permissions: [...ORGANIZATION_MANAGER_PERMISSIONS],
      },
    });
    await seedAcademyMember(admin, academyA.id, manager.userId, 'manager');

    await seedCourse(admin, academyA.id, 'p8t004b-a-course');
    await seedCourse(admin, academyB.id, 'p8t004b-b-course-1');
    await seedCourse(admin, academyB.id, 'p8t004b-b-course-2');

    // The Manager holds a real organization membership, so
    // `OrganizationMembershipGuard` alone would have let them through and
    // handed back org-wide counts spanning academy B. The additional
    // owner-permission check is what refuses it.
    const orgAttempt = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/dashboard`)
      .set('Authorization', `Bearer ${manager.accessToken}`);
    expect(orgAttempt.status).toBe(403);

    // Their OWN academy still works, and reports only academy A's course.
    const own = await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/dashboard`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(own.body.counts.courses).toBe(1);

    // And the owner is unaffected — still sees the whole organization.
    const ownerView = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/dashboard`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(ownerView.body.counts.courses).toBe(3);
  });

  it('P8-TENANT-005: a direct API call with another tenant’s id is refused (no frontend involved)', async () => {
    const userA = await signUpAndSignIn(app, 'p8t005-userA');
    const userB = await signUpAndSignIn(app, 'p8t005-userB');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'p8t005-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p8t005-org2');
    const academy2 = await seedManagedAcademy(admin, org2.id, userB.userId, 'p8t005-a2');
    await seedCourse(admin, academy2.id, 'p8t005-secret-course');

    // Hand-crafted request with B's organization id, A's token.
    const crossOrg = await request(app.getHttpServer())
      .get(`/organizations/${org2.id}/dashboard`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(crossOrg.status).toBe(403);

    // Hand-crafted request with B's academy id, A's token.
    const crossAcademy = await request(app.getHttpServer())
      .get(`/academies/${academy2.id}/dashboard`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(crossAcademy.status).toBe(403);

    // And A's own dashboard still works — the refusals above are real
    // authorization, not a broken endpoint.
    await request(app.getHttpServer())
      .get(`/organizations/${org1.id}/dashboard`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);
  });

  // -------------------------------------------------------------------
  // Support cases
  // -------------------------------------------------------------------

  it('P8-TENANT-006: a support case cannot be created against another tenant', async () => {
    const userA = await signUpAndSignIn(app, 'p8t006-userA');
    const userB = await signUpAndSignIn(app, 'p8t006-userB');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p8t006-org2');
    const academy2 = await seedManagedAcademy(admin, org2.id, userB.userId, 'p8t006-a2');

    const crossOrg = await request(app.getHttpServer())
      .post(`/organizations/${org2.id}/support-cases`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ subject: 'Hijack attempt', description: 'Should never be created.' });
    expect(crossOrg.status).toBe(403);

    const crossAcademy = await request(app.getHttpServer())
      .post(`/academies/${academy2.id}/support-cases`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ subject: 'Hijack attempt', description: 'Should never be created.' });
    expect(crossAcademy.status).toBe(403);

    // Nothing was written for the victim organization.
    const cases = await admin.supportCase.findMany({
      where: { organizationId: org2.id },
    });
    expect(cases).toHaveLength(0);
  });

  it('P8-TENANT-007: a support case cannot be read by another tenant — or another member of the same organization', async () => {
    const owner = await signUpAndSignIn(app, 'p8t007-owner');
    const colleague = await signUpAndSignIn(app, 'p8t007-colleague');
    const outsider = await signUpAndSignIn(app, 'p8t007-outsider');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p8t007-org');
    await seedOrganizationWithOwner(admin, outsider.userId, 'p8t007-other-org');
    // A real second member of the SAME organization.
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: colleague.userId, role: 'manager' },
    });

    const created = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/support-cases`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ subject: 'Private billing question', description: 'Confidential.' })
      .expect(201);
    expect(created.body.id).toBeDefined();

    // The owner sees their own ticket.
    const mine = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/support-cases`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(mine.body.items.map((item: { id: string }) => item.id)).toContain(
      created.body.id,
    );

    // A colleague in the SAME organization does not — a ticket is personal
    // correspondence with the Platform, not organization-shared data.
    const colleagueView = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/support-cases`)
      .set('Authorization', `Bearer ${colleague.accessToken}`)
      .expect(200);
    expect(colleagueView.body.items.map((item: { id: string }) => item.id)).not.toContain(
      created.body.id,
    );

    // And an outsider cannot even reach the route.
    const outsiderView = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/support-cases`)
      .set('Authorization', `Bearer ${outsider.accessToken}`);
    expect(outsiderView.status).toBe(403);
  });

  // -------------------------------------------------------------------
  // Audit correctness
  // -------------------------------------------------------------------

  it('P8-TENANT-008: an audit entry records the real actor, role and academy — never cross-attributed', async () => {
    const owner = await signUpAndSignIn(app, 'p8t008-owner');
    const manager = await signUpAndSignIn(app, 'p8t008-manager');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p8t008-org');
    await seedActiveSubscriptionForOrg(admin, org.id, 'p8t008');
    const academy = await seedManagedAcademy(admin, org.id, owner.userId, 'p8t008-a');
    // A real Manager of this academy, with a real organization membership.
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: manager.userId, role: 'manager' },
    });
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');

    const created = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'P8T008 Managed course',
        slug: `p8t008-${Date.now()}`,
        visibility: 'private',
        pricing: { type: 'free' },
      })
      .expect(201);

    const entry = await admin.auditLogEntry.findFirstOrThrow({
      where: { targetType: 'course', targetId: created.body.id },
    });

    // The MANAGER did this, not the owner — and it is attributed to the
    // one academy it actually happened in, under the right organization.
    expect(entry.actorUserId).toBe(manager.userId);
    expect(entry.role).toBe('manager');
    expect(entry.academyId).toBe(academy.id);
    expect(entry.organizationId).toBe(org.id);
    expect(entry.action).toBe('course.created');
  });

  it('P8-TENANT-009: Course, Curriculum and Learning mutations all write real audit entries', async () => {
    const owner = await signUpAndSignIn(app, 'p8t009-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p8t009-org');
    await seedActiveSubscriptionForOrg(admin, org.id, 'p8t009');
    const academy = await seedManagedAcademy(admin, org.id, owner.userId, 'p8t009-a');
    const auth = { Authorization: `Bearer ${owner.accessToken}` };

    const course = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses`)
      .set(auth)
      .send({
        title: 'P8T009 Course',
        slug: `p8t009-${Date.now()}`,
        visibility: 'private',
        pricing: { type: 'free' },
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.body.id}/publish`)
      .set(auth)
      .expect(200);

    const section = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/courses/${course.body.id}/sections`)
      .set(auth)
      .send({ title: 'P8T009 Section' })
      .expect(201);

    await request(app.getHttpServer())
      .post(
        `/academies/${academy.id}/courses/${course.body.id}/sections/${section.body.id}/lessons`,
      )
      .set(auth)
      .send({ title: 'P8T009 Lesson', contentType: 'text', status: 'draft' })
      .expect(201);

    // Learning authoring (a quiz) — the third of the three surfaces the
    // roadmap named as having zero audit coverage before this phase.
    await request(app.getHttpServer())
      .post(`/courses/${course.body.id}/quizzes`)
      .set(auth)
      .send({
        title: 'P8T009 Quiz',
        status: 'draft',
        questions: [
          {
            prompt: 'Is this audited?',
            type: 'true_false',
            options: [
              { label: 'Yes', isCorrect: true },
              { label: 'No', isCorrect: false },
            ],
          },
        ],
      })
      .expect(201);

    const actions = (
      await admin.auditLogEntry.findMany({
        where: { academyId: academy.id, actorUserId: owner.userId },
        select: { action: true },
      })
    ).map((entry) => entry.action);

    expect(actions).toEqual(
      expect.arrayContaining([
        'course.created',
        'course.published',
        'course_section.created',
        'course_lesson.created',
        'quiz.created',
      ]),
    );
  });

  // -------------------------------------------------------------------
  // Provisioning auto-ticket
  // -------------------------------------------------------------------

  it('P8-TENANT-010/011: the auto-ticket opens at exactly the threshold, and never twice for one episode', async () => {
    const owner = await signUpAndSignIn(app, 'p8t010-owner');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'p8t010-org');

    // A request already sitting one attempt BELOW the threshold, parked on
    // a step that cannot succeed: `subdomain` runs after `academy`, and
    // with no `academyId` set it fails deterministically
    // (`academy_not_ready`) — a real failure path, never a stubbed one.
    const makeRequest = async (attemptCount: number) => {
      const created = await admin.provisioningRequest.create({
        data: {
          organizationId: org.id,
          requestedByUserId: owner.userId,
          status: 'failed',
          currentStepKey: 'subdomain',
          requestedAcademyName: 'P8T010 Academy',
          requestedSubdomain: `p8t010-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          idempotencyKey: `p8t010-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          attemptCount,
        },
      });
      // The real creation path always initializes the full 7-step set in
      // the same transaction as the request row (`ProvisioningStepsRepository.
      // initializeForRequest`) — a fixture that skips it would leave the
      // orchestrator with no step row to mark, which is not a state the
      // real system can ever be in.
      await admin.provisioningStep.createMany({
        data: PROVISIONING_STEP_ORDER.map((key) => ({
          provisioningRequestId: created.id,
          key,
          status: 'pending' as const,
          attemptNumber: 0,
        })),
      });
      return created;
    };

    // --- Below the threshold: no ticket. ---
    const below = await makeRequest(PROVISIONING_AUTO_SUPPORT_CASE_FAILURE_THRESHOLD - 2);
    await orchestrator.runOneStep(below.id, org.id);
    const belowAfter = await admin.provisioningRequest.findUniqueOrThrow({
      where: { id: below.id },
    });
    expect(belowAfter.status).toBe('failed');
    expect(belowAfter.autoSupportCaseId).toBeNull();

    // --- Exactly at the threshold: exactly one ticket. ---
    const atThreshold = await makeRequest(
      PROVISIONING_AUTO_SUPPORT_CASE_FAILURE_THRESHOLD,
    );
    await orchestrator.runOneStep(atThreshold.id, org.id);
    const afterFirst = await admin.provisioningRequest.findUniqueOrThrow({
      where: { id: atThreshold.id },
    });
    expect(afterFirst.autoSupportCaseId).not.toBeNull();

    const ticket = await admin.supportCase.findUniqueOrThrow({
      where: { id: afterFirst.autoSupportCaseId! },
      include: { messages: true },
    });
    expect(ticket.organizationId).toBe(org.id);
    expect(ticket.requesterUserId).toBe(owner.userId);
    // Friendly and non-technical — no stack trace, no error code, no
    // internal identifier anywhere in what the customer reads.
    const body = ticket.messages[0]?.body ?? '';
    expect(body).toContain('P8T010 Academy');
    expect(body).not.toMatch(/error|exception|stack|step_execution_failed|null/i);

    // --- Retried again, still failing: NO second ticket (011). ---
    await orchestrator.runOneStep(atThreshold.id, org.id);
    await orchestrator.runOneStep(atThreshold.id, org.id);

    const afterRetries = await admin.provisioningRequest.findUniqueOrThrow({
      where: { id: atThreshold.id },
    });
    expect(afterRetries.autoSupportCaseId).toBe(afterFirst.autoSupportCaseId);

    const allTicketsForOrg = await admin.supportCase.findMany({
      where: { organizationId: org.id },
    });
    expect(allTicketsForOrg).toHaveLength(1);
  });
});
