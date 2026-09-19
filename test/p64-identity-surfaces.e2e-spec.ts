/**
 * P64 Phase 1 — identity surfaces, registration integrity and the
 * management-surface boundary (master plan Findings F1/F4, AD-4/AD-5, D3).
 *
 * Every case here is a real HTTP round trip against the real database with
 * RLS enforced; nothing is mocked.
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

const PASSWORD = 'correct-horse-battery';

describe('P64 Phase 1 — identity surfaces (e2e)', () => {
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

  async function registerStaff(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function registerLearner(label: string, academyId: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD, academyId })
      .expect(201);
    return { email };
  }

  async function signInLearner(email: string, academyId: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD, surface: 'academy', academyId })
      .expect(200);
    return {
      userId: res.body.user.id as string,
      token: res.body.accessToken as string,
      body: res.body,
    };
  }

  async function seedAcademyWithOwner(label: string) {
    const owner = await registerStaff(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { owner, org, academy };
  }

  // -------------------------------------------------------------------
  // Principal kind
  // -------------------------------------------------------------------

  it('derives the principal kind: learner, staff and platform owner', async () => {
    const { owner, academy } = await seedAcademyWithOwner('principal');
    const learner = await registerLearner('principal-learner', academy.id);
    const session = await signInLearner(learner.email, academy.id);

    expect(session.body.user.principalKind).toBe('learner');
    expect(session.body.user.academies).toHaveLength(1);
    expect(session.body.user.academies[0]).toMatchObject({
      academyId: academy.id,
      blocked: false,
      membershipStatus: 'active',
    });

    const ownerMe = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(ownerMe.body.principalKind).toBe('staff');

    const fresh = await registerStaff('principal-unaffiliated');
    const freshMe = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${fresh.token}`)
      .expect(200);
    // A brand-new account with no fact at all is not a learner — the
    // self-service organization-owner journey must keep working.
    expect(freshMe.body.principalKind).toBe('unaffiliated');
  });

  // -------------------------------------------------------------------
  // Management surface refusal (Finding F1)
  // -------------------------------------------------------------------

  it('refuses a learner on the management surface and names their academies', async () => {
    const { academy } = await seedAcademyWithOwner('refusal');
    const learner = await registerLearner('refusal-learner', academy.id);

    const refused = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: learner.email, password: PASSWORD })
      .expect(403);

    expect(refused.body.error.messageKey).toBe('errors.auth.studentUseAcademySignIn');
    expect(refused.body.error.details.academies).toEqual([
      expect.objectContaining({ academyId: academy.id }),
    ]);
    // No credential of any kind is issued.
    expect(refused.body.accessToken).toBeUndefined();
    expect(refused.body.refreshToken).toBeUndefined();
  });

  it('a learner token cannot call management controllers', async () => {
    const { academy, org } = await seedAcademyWithOwner('mgmt-guard');
    const learner = await registerLearner('mgmt-guard-learner', academy.id);
    const session = await signInLearner(learner.email, academy.id);
    const auth = { Authorization: `Bearer ${session.token}` };

    for (const path of [
      `/academies/${academy.id}`,
      `/academies/${academy.id}/members`,
      `/academies/${academy.id}/students`,
      `/academies/${academy.id}/courses`,
      `/organizations/${org.id}`,
      '/search?q=test',
      '/instructor/courses',
      '/review/courses',
      '/platform-users',
      '/subdomains/availability?subdomain=test',
      '/trial-policy',
      '/payment-methods',
    ]) {
      const res = await request(app.getHttpServer()).get(path).set(auth);
      expect([403, 404]).toContain(res.status);
      if (res.status === 403) {
        expect([
          'errors.auth.managementSurfaceOnly',
          'errors.tenancy.notAMember',
          'errors.forbidden',
        ]).toContain(res.body.error.messageKey);
      }
    }

    // And the one write that previously slipped through the UI.
    const org2 = await request(app.getHttpServer())
      .post('/organizations')
      .set(auth)
      .send({ name: 'Learner Org' });
    expect(org2.status).toBe(403);
  });

  it('staff and platform owners still reach the management surface', async () => {
    const { owner, academy } = await seedAcademyWithOwner('mgmt-ok');
    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/members`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);

    const platform = await registerStaff('mgmt-platform');
    await admin.user.update({
      where: { id: platform.userId },
      data: { isPlatformOwner: true },
    });
    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${platform.token}`)
      .expect(200);
    expect(me.body.principalKind).toBe('platform_owner');
  });

  it('a staff member who is also a learner elsewhere keeps management access', async () => {
    const { owner } = await seedAcademyWithOwner('dual');
    const other = await seedAcademyWithOwner('dual-other');
    // The owner of academy A becomes a student of academy B.
    await admin.academyStudent.create({
      data: {
        academyId: other.academy.id,
        userId: owner.userId,
        status: 'active',
        source: 'self_signup',
      },
    });

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    expect(me.body.principalKind).toBe('staff');
    expect(me.body.academies).toHaveLength(1);

    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: owner.email, password: PASSWORD })
      .expect(200);
  });

  // -------------------------------------------------------------------
  // Academy surface
  // -------------------------------------------------------------------

  it('requires an academy on the academy surface', async () => {
    const { academy } = await seedAcademyWithOwner('academy-ctx');
    const learner = await registerLearner('academy-ctx-learner', academy.id);
    const res = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: learner.email, password: PASSWORD, surface: 'academy' })
      .expect(400);
    expect(res.body.error.messageKey).toBe('errors.auth.academyContextRequired');
  });

  it('an OPEN academy joins a signing-in user who is not yet a member', async () => {
    const first = await seedAcademyWithOwner('join-a');
    const second = await seedAcademyWithOwner('join-b');
    const learner = await registerLearner('join-learner', first.academy.id);

    const session = await signInLearner(learner.email, second.academy.id);
    expect(session.body.user.academies).toHaveLength(2);

    const membership = await admin.academyStudent.findFirstOrThrow({
      where: { academyId: second.academy.id, userId: session.userId },
    });
    expect(membership.source).toBe('sign_in_join');
  });

  it('an INVITE academy refuses a non-member at sign-in and at registration without a token', async () => {
    const { academy } = await seedAcademyWithOwner('invite-policy');
    await admin.academy.update({
      where: { id: academy.id },
      data: { registrationPolicy: 'invite' },
    });

    const outsiderEmail = uniqueTestEmail('invite-outsider');
    const registration = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Outsider',
        email: outsiderEmail,
        password: PASSWORD,
        academyId: academy.id,
      })
      .expect(403);
    expect(registration.body.error.messageKey).toBe('errors.auth.inviteRequired');

    // Existing account, not a member of this academy: refused at sign-in.
    const stranger = await registerStaff('invite-stranger');
    const refused = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({
        email: stranger.email,
        password: PASSWORD,
        surface: 'academy',
        academyId: academy.id,
      })
      .expect(403);
    expect(refused.body.error.messageKey).toBe('errors.auth.notAMemberOfAcademy');
  });

  it('an invite token admits exactly one registration', async () => {
    const { academy, owner, org } = await seedAcademyWithOwner('invite-token');
    await admin.academy.update({
      where: { id: academy.id },
      data: { registrationPolicy: 'invite' },
    });

    const invite = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/invites`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ maxUses: 1, expiresInDays: 7 })
      .expect(201);
    const token = invite.body.token as string;
    expect(token).toBeTruthy();
    expect(org.id).toBeTruthy();

    const firstEmail = uniqueTestEmail('invite-first');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'First',
        email: firstEmail,
        password: PASSWORD,
        academyId: academy.id,
        inviteToken: token,
      })
      .expect(201);

    const secondEmail = uniqueTestEmail('invite-second');
    const second = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Second',
        email: secondEmail,
        password: PASSWORD,
        academyId: academy.id,
        inviteToken: token,
      })
      .expect(400);
    expect(second.body.error.messageKey).toBe('errors.auth.inviteInvalid');

    const membership = await admin.academyStudent.findFirstOrThrow({
      where: { academyId: academy.id, user: { email: firstEmail } },
    });
    expect(membership.source).toBe('invite');
    expect(membership.status).toBe('active');
  });

  it('an APPROVAL academy registers the learner as pending and refuses access until approved', async () => {
    const { academy, owner } = await seedAcademyWithOwner('approval');
    await admin.academy.update({
      where: { id: academy.id },
      data: { registrationPolicy: 'approval' },
    });
    const course = await seedCourse(admin, academy.id, `Approval ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });

    const learner = await registerLearner('approval-learner', academy.id);
    const pending = await admin.academyStudent.findFirstOrThrow({
      where: { academyId: academy.id, user: { email: learner.email } },
    });
    expect(pending.status).toBe('pending');

    const session = await signInLearner(learner.email, academy.id);
    // A pending member cannot enroll — `is_academy_student` requires active.
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ courseId: course.id })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/students/${session.userId}/approve`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${session.token}`)
      .send({ courseId: course.id })
      .expect(201);
  });

  // -------------------------------------------------------------------
  // Registration integrity (Finding F4)
  // -------------------------------------------------------------------

  it('registration is atomic: an unknown academy leaves no user behind', async () => {
    const email = uniqueTestEmail('atomic-unknown');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Atomic',
        email,
        password: PASSWORD,
        academyId: '00000000-0000-4000-8000-000000000000',
      })
      .expect(404);

    const user = await admin.user.findUnique({ where: { email } });
    expect(user).toBeNull();
  });

  it('registration through an academy website creates the membership in the same request', async () => {
    const { academy } = await seedAcademyWithOwner('atomic-ok');
    const email = uniqueTestEmail('atomic-member');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Member', email, password: PASSWORD, academyId: academy.id })
      .expect(201);

    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    const membership = await admin.academyStudent.findFirstOrThrow({
      where: { academyId: academy.id, userId: user.id },
    });
    expect(membership.status).toBe('active');
    expect(membership.source).toBe('self_signup');
    // and the verification token was written in the same transaction
    const tokens = await admin.emailVerificationToken.count({
      where: { userId: user.id },
    });
    expect(tokens).toBe(1);
  });

  // -------------------------------------------------------------------
  // Sessions carry the surface
  // -------------------------------------------------------------------

  it('the session records its surface and academy, and a refresh keeps them', async () => {
    const { academy } = await seedAcademyWithOwner('surface-session');
    const learner = await registerLearner('surface-session-learner', academy.id);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({
        email: learner.email,
        password: PASSWORD,
        surface: 'academy',
        academyId: academy.id,
      })
      .expect(200);

    const user = await admin.user.findUniqueOrThrow({ where: { email: learner.email } });
    const session = await admin.refreshToken.findFirstOrThrow({
      where: { userId: user.id, revokedAt: null },
    });
    expect(session.surface).toBe('academy');
    expect(session.academyId).toBe(academy.id);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: signIn.body.refreshToken })
      .expect(200);

    const rotated = await admin.refreshToken.findFirstOrThrow({
      where: { userId: user.id, revokedAt: null },
    });
    expect(rotated.surface).toBe('academy');
    expect(rotated.academyId).toBe(academy.id);
  });
});
