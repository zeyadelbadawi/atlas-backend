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

  // -------------------------------------------------------------------
  // Issue A — an invite addressed to a specific email is redeemable ONLY
  // by that email. The binding is enforced inside claim_academy_invite's
  // single atomic UPDATE, so it holds against a hand-crafted API request.
  // -------------------------------------------------------------------

  async function inviteAcademy(label: string) {
    const seeded = await seedAcademyWithOwner(label);
    await admin.academy.update({
      where: { id: seeded.academy.id },
      data: { registrationPolicy: 'invite' },
    });
    return seeded;
  }

  async function createInvite(
    academyId: string,
    ownerToken: string,
    body: Record<string, unknown>,
  ) {
    const res = await request(app.getHttpServer())
      .post(`/academies/${academyId}/invites`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body)
      .expect(201);
    return { id: res.body.id as string, token: res.body.token as string };
  }

  function registerWithInvite(
    academyId: string,
    email: string,
    inviteToken: string,
  ) {
    return request(app.getHttpServer()).post('/auth/register').send({
      name: 'Invitee',
      email,
      password: PASSWORD,
      academyId,
      inviteToken,
    });
  }

  it('an email-bound invite admits the invited email', async () => {
    const { academy, owner } = await inviteAcademy('invite-bound-ok');
    const invitedEmail = uniqueTestEmail('invite-bound-ok-invitee');
    const invite = await createInvite(academy.id, owner.token, {
      email: invitedEmail,
      maxUses: 1,
      expiresInDays: 7,
    });

    await registerWithInvite(academy.id, invitedEmail, invite.token).expect(201);

    const membership = await admin.academyStudent.findFirstOrThrow({
      where: { academyId: academy.id, user: { email: invitedEmail } },
    });
    expect(membership.source).toBe('invite');
    expect(membership.status).toBe('active');
  });

  it('an email-bound invite refuses a different authenticated email (server-side) and stays unconsumed', async () => {
    const { academy, owner } = await inviteAcademy('invite-bound-mismatch');
    const invitedEmail = uniqueTestEmail('invite-bound-invitee');
    const invite = await createInvite(academy.id, owner.token, {
      email: invitedEmail,
      maxUses: 1,
      expiresInDays: 7,
    });

    const attacker = uniqueTestEmail('invite-bound-attacker');
    const refused = await registerWithInvite(academy.id, attacker, invite.token).expect(
      400,
    );
    expect(refused.body.error.messageKey).toBe('errors.auth.inviteInvalid');

    // No account and no membership were created for the wrong email...
    const stolen = await admin.academyStudent.findFirst({
      where: { academyId: academy.id, user: { email: attacker } },
    });
    expect(stolen).toBeNull();
    // ...and the invite was NOT consumed, so the real invitee can still use it.
    const row = await admin.academyInvite.findUniqueOrThrow({
      where: { id: invite.id },
    });
    expect(row.usedCount).toBe(0);
    await registerWithInvite(academy.id, invitedEmail, invite.token).expect(201);
  });

  it('the email binding follows the canonical normalization (trim + lowercase)', async () => {
    const { academy, owner } = await inviteAcademy('invite-bound-norm');
    const localPart = `invite-norm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Staff type the invited address in mixed case; it is stored canonically.
    const invite = await createInvite(academy.id, owner.token, {
      email: `${localPart}@Example.COM`,
      maxUses: 1,
      expiresInDays: 7,
    });
    const stored = await admin.academyInvite.findUniqueOrThrow({
      where: { id: invite.id },
    });
    expect(stored.email).toBe(`${localPart}@example.com`);

    // The invitee registers with the canonical (lowercased) address — matches.
    await registerWithInvite(
      academy.id,
      `${localPart}@example.com`,
      invite.token,
    ).expect(201);
  });

  it('an expired email-bound invite is refused', async () => {
    const { academy, owner } = await inviteAcademy('invite-bound-expired');
    const invitedEmail = uniqueTestEmail('invite-bound-expired-invitee');
    const invite = await createInvite(academy.id, owner.token, {
      email: invitedEmail,
      maxUses: 1,
      expiresInDays: 7,
    });
    await admin.academyInvite.update({
      where: { id: invite.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const refused = await registerWithInvite(
      academy.id,
      invitedEmail,
      invite.token,
    ).expect(400);
    expect(refused.body.error.messageKey).toBe('errors.auth.inviteInvalid');
  });

  it('a revoked email-bound invite is refused', async () => {
    const { academy, owner } = await inviteAcademy('invite-bound-revoked');
    const invitedEmail = uniqueTestEmail('invite-bound-revoked-invitee');
    const invite = await createInvite(academy.id, owner.token, {
      email: invitedEmail,
      maxUses: 1,
      expiresInDays: 7,
    });
    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/invites/${invite.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);

    const refused = await registerWithInvite(
      academy.id,
      invitedEmail,
      invite.token,
    ).expect(400);
    expect(refused.body.error.messageKey).toBe('errors.auth.inviteInvalid');
  });

  it('an already-used single-use email-bound invite is refused on replay', async () => {
    const { academy, owner } = await inviteAcademy('invite-bound-replay');
    const invitedEmail = uniqueTestEmail('invite-bound-replay-invitee');
    const invite = await createInvite(academy.id, owner.token, {
      email: invitedEmail,
      maxUses: 1,
      expiresInDays: 7,
    });
    await registerWithInvite(academy.id, invitedEmail, invite.token).expect(201);

    // Same invited email, same token, but the single use is spent.
    const replayEmail = uniqueTestEmail('invite-bound-replay-second');
    await admin.academyInvite.update({
      where: { id: invite.id },
      data: { email: replayEmail },
    });
    const refused = await registerWithInvite(
      academy.id,
      replayEmail,
      invite.token,
    ).expect(400);
    expect(refused.body.error.messageKey).toBe('errors.auth.inviteInvalid');
  });

  it("an invite for Academy A cannot be redeemed into Academy B", async () => {
    const a = await inviteAcademy('invite-bound-cross-a');
    const b = await inviteAcademy('invite-bound-cross-b');
    const invitedEmail = uniqueTestEmail('invite-bound-cross-invitee');
    const invite = await createInvite(a.academy.id, a.owner.token, {
      email: invitedEmail,
      maxUses: 1,
      expiresInDays: 7,
    });

    // Right email, right token, but pointed at the other academy.
    const refused = await registerWithInvite(
      b.academy.id,
      invitedEmail,
      invite.token,
    ).expect(400);
    expect(refused.body.error.messageKey).toBe('errors.auth.inviteInvalid');

    const row = await admin.academyInvite.findUniqueOrThrow({
      where: { id: invite.id },
    });
    expect(row.usedCount).toBe(0);
  });

  it('a manual API request with a mismatched email cannot bypass the binding', async () => {
    // The redemption endpoint IS the public API; there is no hidden path.
    // A caller who holds the raw token and hand-crafts the register body
    // with any email but the invited one is still refused at the DB claim.
    const { academy, owner } = await inviteAcademy('invite-bound-manual');
    const invitedEmail = uniqueTestEmail('invite-bound-manual-invitee');
    const invite = await createInvite(academy.id, owner.token, {
      email: invitedEmail,
      maxUses: 5, // even with uses to spare, the wrong email cannot claim one
      expiresInDays: 7,
    });

    for (const forged of [
      uniqueTestEmail('invite-bound-manual-x1'),
      // A well-formed address that merely resembles the invitee's local part.
      `not-${invitedEmail}`,
      uniqueTestEmail('invite-bound-manual-x2'),
    ]) {
      const refused = await registerWithInvite(academy.id, forged, invite.token).expect(
        400,
      );
      expect(refused.body.error.messageKey).toBe('errors.auth.inviteInvalid');
    }
    const row = await admin.academyInvite.findUniqueOrThrow({
      where: { id: invite.id },
    });
    expect(row.usedCount).toBe(0);
  });

  it('an open (no-email) invite still works for any registrant (backward compatible)', async () => {
    const { academy, owner } = await inviteAcademy('invite-bound-open');
    const invite = await createInvite(academy.id, owner.token, {
      maxUses: 1,
      expiresInDays: 7,
    });
    const anyEmail = uniqueTestEmail('invite-bound-open-anyone');
    await registerWithInvite(academy.id, anyEmail, invite.token).expect(201);

    const membership = await admin.academyStudent.findFirstOrThrow({
      where: { academyId: academy.id, user: { email: anyEmail } },
    });
    expect(membership.source).toBe('invite');
  });

  // -------------------------------------------------------------------
  // Invitation CREATION email trust — an invite may only be BOUND to an
  // address that clears the SAME gate sign-up applies
  // (`AuthService.register` → `EmailRiskService.evaluate`): disposable
  // blocking (always on) plus deliverability (DNS, off in `test`). This
  // is the same architecture as sign-up, not a second validator; Atlas
  // cannot prove mailbox ownership at creation, so ownership is still
  // proven only at redemption (the invited email must register and clear
  // the same gate). The enforcement is server-side in
  // `AcademyStudentsService.createInvite`.
  // -------------------------------------------------------------------

  // Unlike the `createInvite` helper above, this returns the raw response
  // so a rejection can be asserted.
  function postInvite(
    academyId: string,
    ownerToken: string,
    body: Record<string, unknown>,
  ) {
    return request(app.getHttpServer())
      .post(`/academies/${academyId}/invites`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body);
  }

  it('a legitimate email-bound invite is created (normal address clears the gate)', async () => {
    const { academy, owner } = await inviteAcademy('invite-trust-ok');
    const invitedEmail = uniqueTestEmail('invite-trust-ok-invitee');
    const res = await postInvite(academy.id, owner.token, {
      email: invitedEmail,
      maxUses: 1,
      expiresInDays: 7,
    }).expect(201);
    expect(res.body.id).toBeTruthy();

    const stored = await admin.academyInvite.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(stored.email).toBe(invitedEmail);
  });

  it('a mixed-case invited address is normalized and still accepted at creation', async () => {
    const { academy, owner } = await inviteAcademy('invite-trust-norm');
    const localPart = `invite-trust-norm-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const res = await postInvite(academy.id, owner.token, {
      email: `${localPart}@Example.COM`,
      maxUses: 1,
    }).expect(201);

    const stored = await admin.academyInvite.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    // Normalized before both the trust check and storage (lowercase); the
    // gate sees the canonical form, so case never smuggles a domain past it.
    expect(stored.email).toBe(`${localPart}@example.com`);
  });

  it('an invite bound to a DISPOSABLE provider is REJECTED and no invite row is written', async () => {
    // `mailinator.com` is in the community disposable dataset; that half of
    // the gate is local and always active, in `test` too. Same key as
    // sign-up refuses — never disclosing which check tripped.
    const { academy, owner } = await inviteAcademy('invite-trust-disposable');
    const before = await admin.academyInvite.count({
      where: { academyId: academy.id },
    });

    const refused = await postInvite(academy.id, owner.token, {
      email: `invite-trust-disp-${Date.now()}@mailinator.com`,
      maxUses: 1,
    }).expect(400);
    expect(refused.body.error.messageKey).toBe('errors.auth.emailNotAcceptable');
    // The rejection never names the domain, the list, or the mechanism.
    const serialised = JSON.stringify(refused.body);
    expect(serialised).not.toContain('mailinator');
    expect(serialised.toLowerCase()).not.toContain('disposable');

    const after = await admin.academyInvite.count({
      where: { academyId: academy.id },
    });
    expect(after).toBe(before);
  });

  it('several distinct throwaway providers are all rejected at invite creation', async () => {
    const { academy, owner } = await inviteAcademy('invite-trust-throwaway');
    for (const domain of ['guerrillamail.com', 'yopmail.com', '10minutemail.com']) {
      const refused = await postInvite(academy.id, owner.token, {
        email: `invite-trust-${Date.now()}@${domain}`,
        maxUses: 1,
      }).expect(400);
      expect(refused.body.error.messageKey).toBe('errors.auth.emailNotAcceptable');
    }
    const count = await admin.academyInvite.count({
      where: { academyId: academy.id },
    });
    expect(count).toBe(0);
  });

  it('an OPEN (no-email) invite bypasses the address gate — backward compatible', async () => {
    // No address is bound, so there is nothing to trust or reject; the
    // gate applies only to email-bound invites.
    const { academy, owner } = await inviteAcademy('invite-trust-open');
    const res = await postInvite(academy.id, owner.token, {
      maxUses: 5,
      expiresInDays: 7,
    }).expect(201);
    const stored = await admin.academyInvite.findUniqueOrThrow({
      where: { id: res.body.id },
    });
    expect(stored.email).toBeNull();
  });

  it('the API itself enforces the gate — a direct request cannot bind a throwaway address (no frontend involved)', async () => {
    // There is no frontend in this test: the request goes straight to the
    // authoritative endpoint. Frontend validation is not a security control;
    // the refusal must come from the server, on the API path itself.
    const { academy, owner } = await inviteAcademy('invite-trust-api');
    const refused = await postInvite(academy.id, owner.token, {
      email: `invite-trust-api-${Date.now()}@mailinator.com`,
      maxUses: 1,
      expiresInDays: 7,
    }).expect(400);
    expect(refused.body.error.messageKey).toBe('errors.auth.emailNotAcceptable');
    const count = await admin.academyInvite.count({
      where: { academyId: academy.id },
    });
    expect(count).toBe(0);
  });

  // HONEST LIMITATION — mailbox OWNERSHIP is not proven at creation time.
  // The invite is created bound to the normalized address, but ownership
  // is proven only when the invited person registers with that exact
  // address (bound by `claim_academy_invite`) and clears the same gate.
  // This test documents that the redemption binding still holds after a
  // trust-checked creation.
  it('a trust-checked email-bound invite is still redeemable ONLY by the invited address', async () => {
    const { academy, owner } = await inviteAcademy('invite-trust-redeem');
    const invitedEmail = uniqueTestEmail('invite-trust-redeem-invitee');
    const invite = await createInvite(academy.id, owner.token, {
      email: invitedEmail,
      maxUses: 1,
      expiresInDays: 7,
    });

    // A different (also legitimate) address cannot claim it...
    const attacker = uniqueTestEmail('invite-trust-redeem-attacker');
    const refused = await registerWithInvite(
      academy.id,
      attacker,
      invite.token,
    ).expect(400);
    expect(refused.body.error.messageKey).toBe('errors.auth.inviteInvalid');

    // ...and the invited address still can (ownership proven here, at
    // redemption, not at creation).
    await registerWithInvite(academy.id, invitedEmail, invite.token).expect(201);
    const membership = await admin.academyStudent.findFirstOrThrow({
      where: { academyId: academy.id, user: { email: invitedEmail } },
    });
    expect(membership.source).toBe('invite');
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
