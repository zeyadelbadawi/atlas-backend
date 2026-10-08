/**
 * Launch Stabilization (Plan A: A1–A6) — end to end against the real
 * `AppModule`, real Postgres with FORCE RLS, real Redis and the real
 * communications outbox. See docs/ATLAS_LAUNCH_STABILIZATION_PLAN.md.
 *
 *   A1 (D1) an academy-website session is never a management credential
 *   A2 (D2) staff-created accounts carry no password anybody else chose
 *   A3 (D3) password reset/change ends live access tokens immediately
 *   A4      an existing account joins another academy through its signup
 *   A5      an academy session is told only about its own academy
 *   A6      academy sign-in OTP + academy-scoped trusted devices
 *
 * Academy hosts are real, connected custom hostnames (`domain_connections`),
 * so every host rule is exercised through the same resolver production uses,
 * independent of `PLATFORM_BASE_DOMAIN`.
 *
 * Academy OTP runs in `new_device` (as in production) for this app; the
 * management flag is left at its test default (`off`), so management
 * sign-ins in fixtures stay one step. Both are restored afterwards.
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
  seedCourse,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { TRUST_COOKIE_NAME } from '../src/identity/services/trusted-device.service';
import { METRICS_REGISTRY } from '../src/observability/metrics/learning-metrics.service';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../src/identity/utils/opaque-token.util';
import { uniqueName } from './utils/unique-name';

jest.setTimeout(120000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-stab';

describe('Launch Stabilization — Plan A (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let previousAcademyFlag: string | undefined;

  beforeAll(async () => {
    previousAcademyFlag = process.env.FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY;
    process.env.FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY = 'new_device';
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
    if (previousAcademyFlag === undefined) {
      delete process.env.FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY;
    } else {
      process.env.FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY = previousAcademyFlag;
    }
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  // ------------------------------------------------------------------
  // fixtures
  // ------------------------------------------------------------------

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  interface Academy {
    readonly id: string;
    readonly orgId: string;
    readonly host: string;
  }

  /** A management-registered account (no academy), signed in on management. */
  async function staffAccount(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  /** An academy with its own connected custom hostname, owned by `ownerUserId`. */
  async function academyOwnedBy(
    ownerUserId: string,
    label: string,
    policy: 'open' | 'invite' | 'approval' = 'open',
  ): Promise<Academy> {
    const org = await seedOrganizationWithOwner(admin, ownerUserId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({
      where: { id: academy.id },
      data: { status: 'active', registrationPolicy: policy },
    });
    await seedAcademyMember(admin, academy.id, ownerUserId, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.stab.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: host, status: 'connected' },
    });
    return { id: academy.id, orgId: org.id, host };
  }

  async function freshAcademy(label: string, policy?: 'open' | 'invite' | 'approval') {
    const owner = await staffAccount(`${label}-owner`);
    return { owner, academy: await academyOwnedBy(owner.userId, label, policy) };
  }

  function registerAt(a: Academy, email: string, password = PASSWORD, extra = {}) {
    return (
      http()
        .post('/auth/register')
        .set('Host', a.host)
        // W4 — learner names are unique per academy: each learner gets its own.
        .send({ name: uniqueName('Learner'), email, password, academyId: a.id, ...extra })
    );
  }

  function signInAt(
    a: Academy,
    email: string,
    trustCookie?: string,
    password = PASSWORD,
  ) {
    const req = http()
      .post('/auth/sign-in')
      .set('Host', a.host)
      .send({ email, password, surface: 'academy', academyId: a.id });
    return trustCookie ? req.set('Cookie', `${TRUST_COOKIE_NAME}=${trustCookie}`) : req;
  }

  async function latestCode(userId: string): Promise<string> {
    const rows = await admin.$queryRaw<{ values: { code?: string } | null }[]>`
      SELECT "values" FROM "communication_outbox"
      WHERE "recipient_user_id" = ${userId} AND "key" = 'auth.email.otp'
      ORDER BY "created_at" DESC LIMIT 1
    `;
    const code = rows[0]?.values?.code;
    if (typeof code !== 'string') throw new Error('No OTP outbox row for that user.');
    return code;
  }

  function verifyAt(
    host: string | null,
    challengeId: string,
    code: string,
    rememberDevice = false,
  ) {
    const req = http()
      .post('/auth/otp/verify')
      .send({ challengeId, code, rememberDevice, surface: 'academy' });
    return host ? req.set('Host', host) : req;
  }

  function readTrustCookie(response: request.Response): string {
    const header = response.headers['set-cookie'] as unknown as string[] | undefined;
    const raw = (header ?? []).find((v) => v.startsWith(`${TRUST_COOKIE_NAME}=`));
    if (!raw) throw new Error('No atlas_trust cookie was set.');
    return decodeURIComponent(raw.split(';')[0].slice(TRUST_COOKIE_NAME.length + 1));
  }

  async function userIdOf(email: string): Promise<string> {
    return (await admin.user.findUniqueOrThrow({ where: { email } })).id;
  }

  /** Full academy sign-in: password, then the emailed code. Returns the session response. */
  async function academySession(a: Academy, email: string, rememberDevice = false) {
    const open = await signInAt(a, email).expect(200);
    if (open.body.accessToken) return open;
    expect(open.body.emailOtpRequired).toBe(true);
    const code = await latestCode(await userIdOf(email));
    return verifyAt(a.host, open.body.challengeId, code, rememberDevice).expect(200);
  }

  /** A learner account registered at `a` (brand new). */
  async function learnerAt(a: Academy, label: string) {
    const email = uniqueTestEmail(label);
    await registerAt(a, email).expect(201);
    return { email, userId: await userIdOf(email) };
  }

  // ==================================================================
  // A1 — an academy-website session is never a management credential
  // ==================================================================

  describe('A1 (D1) — session surface', () => {
    it('LS-A1-01 — an academy session of an organization owner is refused on that owner’s own management API; a management session is not', async () => {
      const { owner, academy: a } = await freshAcademy('a1-own');
      const { academy: b } = await freshAcademy('a1-other');
      // The owner of A also learns at B.
      await registerAt(b, owner.email).expect(201);
      const bSession = await academySession(b, owner.email);

      const refused = await http()
        .get(`/academies/${a.id}`)
        .set(bearer(bSession.body.accessToken));
      expect(refused.status).toBe(403);
      expect(refused.body.error.messageKey).toBe('errors.auth.managementSurfaceOnly');

      await http().get(`/academies/${a.id}`).set(bearer(owner.token)).expect(200);
    });

    it('LS-A1-02 — staff authoring, moderation, platform and account-deletion routes refuse academy sessions', async () => {
      const { owner, academy: a } = await freshAcademy('a1-routes');
      const course = await seedCourse(admin, a.id, 'a1-course');
      const session = await academySession(a, owner.email);
      const auth = bearer(session.body.accessToken);

      const probes: [string, string, object?][] = [
        ['post', `/courses/${course.id}/quizzes`, { title: 'q' }],
        ['get', `/courses/${course.id}/quizzes/authoring`],
        ['post', `/courses/${course.id}/assignments`, { title: 'a' }],
        ['get', `/courses/${course.id}/reviews/moderation`],
        ['post', `/academies/${a.id}/announcements`, { title: 't', body: 'b' }],
        ['post', '/platform/announcements', { title: 't', body: 'b' }],
        ['get', '/platform-users'],
        ['post', '/users/me/delete', { confirm: true }],
        ['get', '/users/me/deletion-plan'],
      ];
      for (const [method, path, body] of probes) {
        const req = (http() as unknown as Record<string, (p: string) => request.Test>)
          [method](path)
          .set(auth);
        const res = await (body ? req.send(body) : req);
        expect({ path, status: res.status }).toEqual({ path, status: 403 });
      }
      // Nothing was deleted.
      const still = await admin.user.findUniqueOrThrow({ where: { id: owner.userId } });
      expect(still.status).toBe('active');
    });

    it('LS-A1-03 — an academy session acts only on its own academy’s host', async () => {
      const { academy: a } = await freshAcademy('a1-host-a');
      const { academy: b } = await freshAcademy('a1-host-b');
      const learner = await learnerAt(a, 'a1-host-learner');
      await registerAt(b, learner.email).expect(201);
      const aSession = await academySession(a, learner.email);
      const auth = bearer(aSession.body.accessToken);

      await http().get('/learning/overview').set('Host', a.host).set(auth).expect(200);
      const cross = await http().get('/learning/overview').set('Host', b.host).set(auth);
      expect(cross.status).toBe(403);
      expect(cross.body.error.messageKey).toBe('errors.auth.academyHostMismatch');
    });

    it('LS-A1-04 — a pure learner token is still refused on management (regression)', async () => {
      const { academy: a } = await freshAcademy('a1-learner');
      const learner = await learnerAt(a, 'a1-learner-only');
      const session = await academySession(a, learner.email);
      await http()
        .get(`/academies/${a.id}/members`)
        .set(bearer(session.body.accessToken))
        .expect(403);
    });
  });

  // ==================================================================
  // A2 — no password chosen by another person
  // ==================================================================

  describe('A2 (D2) — invited accounts', () => {
    it('LS-A2-01 — a manager created by the owner cannot sign in with the owner-typed password; the setup link activates the account', async () => {
      const { owner, academy: a } = await freshAcademy('a2-mgr');
      const email = uniqueTestEmail('a2-new-manager');
      await http()
        .post(`/academies/${a.id}/members`)
        .set(bearer(owner.token))
        .send({ email, name: 'New Manager', password: 'owner-chose-this-1' })
        .expect(201);

      const created = await admin.user.findUniqueOrThrow({ where: { email } });
      expect(created.status).toBe('invited');
      expect(created.emailVerifiedAt).toBeNull();

      const refused = await http()
        .post('/auth/sign-in')
        .send({ email, password: 'owner-chose-this-1' });
      expect(refused.status).toBe(401);
      expect(refused.body.error.messageKey).toBe('errors.auth.invalidCredentials');

      // The person uses their setup (reset-token) link and chooses a password.
      const raw = generateOpaqueToken();
      await admin.passwordResetToken.create({
        data: {
          userId: created.id,
          tokenHash: hashOpaqueToken(raw),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      await http()
        .post('/auth/password-reset/confirm')
        .send({ token: raw, newPassword: 'my-own-password-1' })
        .expect(200);
      const activated = await admin.user.findUniqueOrThrow({ where: { email } });
      expect(activated.status).toBe('active');
      expect(activated.emailVerifiedAt).not.toBeNull();

      await http()
        .post('/auth/sign-in')
        .send({ email, password: 'my-own-password-1' })
        .expect(200);
    });

    it('LS-A2-02 — a student created by staff needs no password field and is invited', async () => {
      const { owner, academy: a } = await freshAcademy('a2-stu');
      const email = uniqueTestEmail('a2-new-student');
      await http()
        .post(`/academies/${a.id}/students`)
        .set(bearer(owner.token))
        .send({ email, name: 'New Student' })
        .expect(201);
      const created = await admin.user.findUniqueOrThrow({ where: { email } });
      expect(created.status).toBe('invited');
    });

    it('LS-A2-03 — adding an EXISTING account as manager leaves its password untouched', async () => {
      const { owner, academy: a } = await freshAcademy('a2-existing');
      const existing = await staffAccount('a2-existing-person');
      // A person who proved their mailbox. An UNPROVEN account is returned
      // to `invited` by a grant instead (ATO review F1, ato-hardening ATO-F1).
      await admin.user.update({
        where: { id: existing.userId },
        data: { emailVerifiedAt: new Date() },
      });
      const before = await admin.userCredential.findUniqueOrThrow({
        where: { userId: existing.userId },
      });
      await http()
        .post(`/academies/${a.id}/members`)
        .set(bearer(owner.token))
        .send({ email: existing.email, name: 'Ignored', password: 'ignored-password-1' })
        .expect(201);
      const after = await admin.user.findUniqueOrThrow({
        where: { id: existing.userId },
      });
      const credentialAfter = await admin.userCredential.findUniqueOrThrow({
        where: { userId: existing.userId },
      });
      expect(credentialAfter.passwordHash).toBe(before.passwordHash);
      expect(after.status).toBe('active');
    });

    it('LS-A2-04 — a LEGACY staff-created account (active, password chosen by staff before A2) keeps working unchanged', async () => {
      // Before A2, staff creation produced exactly this row: `active`, with a
      // password the creator typed. Nothing in this release migrates it.
      const { academy: a } = await freshAcademy('a2-legacy');
      const legacy = await staffAccount('a2-legacy-staff');
      await seedMembership(admin, a.orgId, legacy.userId, 'manager');
      await seedAcademyMember(admin, a.id, legacy.userId, 'manager');
      const before = await admin.user.findUniqueOrThrow({ where: { id: legacy.userId } });

      // Still signs in with that password and still reaches management.
      const mgmt = await http()
        .post('/auth/sign-in')
        .send({ email: legacy.email, password: PASSWORD })
        .expect(200);
      await http()
        .get(`/academies/${a.id}`)
        .set(bearer(mgmt.body.accessToken))
        .expect(200);

      // A reset keeps it `active` (activation only ever moves `invited` → `active`).
      const raw = generateOpaqueToken();
      await admin.passwordResetToken.create({
        data: {
          userId: legacy.userId,
          tokenHash: hashOpaqueToken(raw),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      await http()
        .post('/auth/password-reset/confirm')
        .send({ token: raw, newPassword: 'legacy-own-password-1' })
        .expect(200);
      const after = await admin.user.findUniqueOrThrow({ where: { id: legacy.userId } });
      expect(before.status).toBe('active');
      expect(after.status).toBe('active');
      // ATO review F1 — the link reaching the inbox is the first proof of
      // the address for a legacy account staff created: it is recorded.
      expect(before.emailVerifiedAt).toBeNull();
      expect(after.emailVerifiedAt).not.toBeNull();
      await http()
        .post('/auth/sign-in')
        .send({ email: legacy.email, password: 'legacy-own-password-1' })
        .expect(200);
    });
  });

  // ==================================================================
  // A3 — password reset/change end live access tokens now
  // ==================================================================

  describe('A3 (D3) — revocation', () => {
    it('LS-A3-01 — a password reset makes every earlier access token fail on the next request', async () => {
      const person = await staffAccount('a3-reset');
      const second = await http()
        .post('/auth/sign-in')
        .send({ email: person.email, password: PASSWORD })
        .expect(200);

      const raw = generateOpaqueToken();
      await admin.passwordResetToken.create({
        data: {
          userId: person.userId,
          tokenHash: hashOpaqueToken(raw),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      await http()
        .post('/auth/password-reset/confirm')
        .send({ token: raw, newPassword: 'brand-new-password-1' })
        .expect(200);

      await http().get('/users/me').set(bearer(person.token)).expect(401);
      await http().get('/users/me').set(bearer(second.body.accessToken)).expect(401);
    });

    it('LS-A3-02 — a password change ends every session, including the one that changed it', async () => {
      const person = await staffAccount('a3-change');
      const other = await http()
        .post('/auth/sign-in')
        .send({ email: person.email, password: PASSWORD })
        .expect(200);
      await http()
        .post('/users/me/password')
        .set(bearer(person.token))
        .send({ currentPassword: PASSWORD, newPassword: 'changed-password-1' })
        .expect(200);
      await http().get('/users/me').set(bearer(other.body.accessToken)).expect(401);
      await http().get('/users/me').set(bearer(person.token)).expect(401);
    });
  });

  // ==================================================================
  // A4 — existing account joins another academy
  // ==================================================================

  describe('A4 — cross-academy learner identity', () => {
    it('LS-A4-01 (J2) — a learner of A signs up at B with their password: one user, two learner rows', async () => {
      const { academy: a } = await freshAcademy('a4-a');
      const { academy: b } = await freshAcademy('a4-b');
      const learner = await learnerAt(a, 'a4-learner');

      const joined = await registerAt(b, learner.email).expect(201);
      expect(joined.body).toEqual({ account: 'existing', status: 'active' });

      expect(await admin.user.count({ where: { email: learner.email } })).toBe(1);
      const rows = await admin.academyStudent.findMany({
        where: { userId: learner.userId },
        select: { academyId: true, status: true },
      });
      expect(rows.map((r) => r.academyId).sort()).toEqual([a.id, b.id].sort());

      // The owner is told, through the outbox.
      const notice = await admin.communicationOutbox.findFirst({
        where: { recipientUserId: learner.userId, key: 'account.academy.joined' },
      });
      expect(notice).not.toBeNull();

      // And signs in at B with the SAME password.
      const session = await academySession(b, learner.email);
      expect(
        session.body.user.academies.map((x: { academyId: string }) => x.academyId),
      ).toEqual([b.id]);
    });

    it('LS-A4-02 — a wrong password gets the new-address answer (audit Decision 3), and writes nothing', async () => {
      const { academy: a } = await freshAcademy('a4-wrong-a');
      const { academy: b } = await freshAcademy('a4-wrong-b');
      const learner = await learnerAt(a, 'a4-wrong');

      const res = await registerAt(b, learner.email, 'not-the-password-1').expect(201);
      expect(res.body).toEqual({ account: 'new' });
      expect(
        await admin.academyStudent.count({
          where: { userId: learner.userId, academyId: b.id },
        }),
      ).toBe(0);
    });

    it('LS-A4-03 (J6) — signing up again at the same academy is refused after the password is proven', async () => {
      const { academy: a } = await freshAcademy('a4-again');
      const learner = await learnerAt(a, 'a4-again-learner');
      const res = await registerAt(a, learner.email).expect(409);
      expect(res.body.error.messageKey).toBe('errors.auth.alreadyLearnerHere');
      expect(
        await admin.academyStudent.count({ where: { userId: learner.userId } }),
      ).toBe(1);
    });

    it('LS-A4-04 (J3/J4/J5) — owner, manager and instructor accounts can become learners elsewhere; their roles are untouched', async () => {
      const { owner, academy: a } = await freshAcademy('a4-staff');
      const { academy: b } = await freshAcademy('a4-staff-b');
      const manager = await staffAccount('a4-manager');
      await seedMembership(admin, a.orgId, manager.userId, 'manager');
      await seedAcademyMember(admin, a.id, manager.userId, 'manager');
      const instructor = await staffAccount('a4-instructor');
      await seedMembership(admin, a.orgId, instructor.userId, 'instructor');
      await seedAcademyMember(admin, a.id, instructor.userId, 'instructor');

      for (const person of [owner, manager, instructor]) {
        const before = await admin.organizationMembership.findMany({
          where: { userId: person.userId },
          select: { organizationId: true, role: true },
        });
        const res = await registerAt(b, person.email).expect(201);
        expect(res.body).toEqual({ account: 'existing', status: 'active' });
        const after = await admin.organizationMembership.findMany({
          where: { userId: person.userId },
          select: { organizationId: true, role: true },
        });
        expect(after).toEqual(before);
        // Management still works with the management session.
        const mgmt = await http()
          .post('/auth/sign-in')
          .send({ email: person.email, password: PASSWORD })
          .expect(200);
        // …and it still carries the same organization roles.
        const me = await http()
          .get('/users/me')
          .set(bearer(mgmt.body.accessToken))
          .expect(200);
        expect(
          me.body.organizationMemberships.map(
            (m: { organizationId: string }) => m.organizationId,
          ),
        ).toContain(a.orgId);
        if (person !== instructor) {
          // Instructors cannot read academy settings under existing RBAC; owners/managers can.
          await http()
            .get(`/academies/${a.id}`)
            .set(bearer(mgmt.body.accessToken))
            .expect(200);
        }
      }
    });

    it('LS-A4-05 — concurrent joins of the same academy: exactly one succeeds', async () => {
      const { academy: a } = await freshAcademy('a4-race-a');
      const { academy: b } = await freshAcademy('a4-race-b');
      const learner = await learnerAt(a, 'a4-race');
      const results = await Promise.all([
        registerAt(b, learner.email),
        registerAt(b, learner.email),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(
        await admin.academyStudent.count({
          where: { userId: learner.userId, academyId: b.id },
        }),
      ).toBe(1);
    });

    it('LS-A4-06 — invite-only academy: an existing account needs an invite bound to ITS email', async () => {
      const { academy: a } = await freshAcademy('a4-inv-a');
      const { academy: b } = await freshAcademy('a4-inv-b', 'invite');
      const learner = await learnerAt(a, 'a4-inv');

      const noInvite = await registerAt(b, learner.email).expect(403);
      expect(noInvite.body.error.messageKey).toBe('errors.auth.inviteRequired');

      const foreign = generateOpaqueToken();
      await admin.academyInvite.create({
        data: {
          academyId: b.id,
          tokenHash: hashOpaqueToken(foreign),
          createdBy: learner.userId,
          email: 'someone-else@atlas.test',
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      await registerAt(b, learner.email, PASSWORD, { inviteToken: foreign }).expect(400);

      const own = generateOpaqueToken();
      await admin.academyInvite.create({
        data: {
          academyId: b.id,
          tokenHash: hashOpaqueToken(own),
          createdBy: learner.userId,
          email: learner.email,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      await registerAt(b, learner.email, PASSWORD, { inviteToken: own }).expect(201);
    });

    it('LS-A4-07 — a body academyId that is not the host’s academy is refused', async () => {
      const { academy: a } = await freshAcademy('a4-host-a');
      const { academy: b } = await freshAcademy('a4-host-b');
      const learner = await learnerAt(a, 'a4-host');
      const res = await http().post('/auth/register').set('Host', a.host).send({
        name: 'Learner',
        email: learner.email,
        password: PASSWORD,
        academyId: b.id,
      });
      expect(res.status).toBe(403);
    });

    it('LS-A4-08 — the join path shares the per-account sign-in budget (no unmetered password oracle)', async () => {
      const { academy: a } = await freshAcademy('a4-rate-a');
      const { academy: b } = await freshAcademy('a4-rate-b');
      const learner = await learnerAt(a, 'a4-rate');
      const statuses: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        statuses.push((await registerAt(b, learner.email, `wrong-password-${i}`)).status);
      }
      expect(statuses).toContain(429);
    });
  });

  // ==================================================================
  // A5 — academy-scoped /users/me
  // ==================================================================

  describe('A5 — academy-scoped CurrentUser', () => {
    it('LS-A5-01 — an academy session sees only its own academy and no organizations', async () => {
      const { owner, academy: a } = await freshAcademy('a5-a');
      const { academy: b } = await freshAcademy('a5-b');
      await registerAt(b, owner.email).expect(201);
      const bSession = await academySession(b, owner.email);

      const me = await http()
        .get('/users/me')
        .set(bearer(bSession.body.accessToken))
        .expect(200);
      expect(me.body.academies.map((x: { academyId: string }) => x.academyId)).toEqual([
        b.id,
      ]);
      expect(me.body.organizations).toEqual([]);
      expect(me.body.organizationMemberships).toEqual([]);
      expect(me.body.principalKind).toBe('learner');
      expect(bSession.body.user.organizations).toEqual([]);

      const mgmt = await http().get('/users/me').set(bearer(owner.token)).expect(200);
      expect(
        mgmt.body.organizationMemberships.map(
          (m: { organizationId: string }) => m.organizationId,
        ),
      ).toContain(a.orgId);
    });
  });

  // ==================================================================
  // A6 — academy OTP + academy-scoped trusted devices
  // ==================================================================

  describe('A6 — academy OTP and trusted devices', () => {
    it('LS-A6-01/02 — password then code; a remembered browser skips the code on the SAME academy', async () => {
      const { academy: a } = await freshAcademy('a6-trust');
      const learner = await learnerAt(a, 'a6-trust-l');
      const open = await signInAt(a, learner.email).expect(200);
      expect(open.body.emailOtpRequired).toBe(true);
      expect(open.body.accessToken).toBeUndefined();

      const verified = await verifyAt(
        a.host,
        open.body.challengeId,
        await latestCode(learner.userId),
        true,
      ).expect(200);
      expect(verified.body.accessToken).toEqual(expect.any(String));
      const cookie = readTrustCookie(verified);

      const trusted = await signInAt(a, learner.email, cookie).expect(200);
      expect(trusted.body.accessToken).toEqual(expect.any(String));

      const row = await admin.trustedDevice.findFirstOrThrow({
        where: { userId: learner.userId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      expect(row).toMatchObject({ surface: 'academy', academyId: a.id });
    });

    it('LS-A6-03 — Academy A’s trusted device does NOT skip the code on Academy B', async () => {
      const { academy: a } = await freshAcademy('a6-cross-a');
      const { academy: b } = await freshAcademy('a6-cross-b');
      const learner = await learnerAt(a, 'a6-cross');
      await registerAt(b, learner.email).expect(201);
      const verified = await academySession(a, learner.email, true);
      const cookie = readTrustCookie(verified);

      const atB = await signInAt(b, learner.email, cookie).expect(200);
      expect(atB.body.emailOtpRequired).toBe(true);
      expect(atB.body.accessToken).toBeUndefined();
    });

    it('LS-A6-04 — a code issued for Academy A fails on Academy B’s host, generically, with no session', async () => {
      const { academy: a } = await freshAcademy('a6-code-a');
      const { academy: b } = await freshAcademy('a6-code-b');
      const learner = await learnerAt(a, 'a6-code');
      await registerAt(b, learner.email).expect(201);

      const open = await signInAt(a, learner.email).expect(200);
      const code = await latestCode(learner.userId);
      const wrongHost = await verifyAt(b.host, open.body.challengeId, code).expect(401);
      expect(wrongHost.body.error.messageKey).toBe('errors.auth.otpInvalid');
      expect(wrongHost.body.accessToken).toBeUndefined();
      // The same code still works where it was issued (an attempt was spent, not the challenge).
      await verifyAt(a.host, open.body.challengeId, code).expect(200);
    });

    it('LS-A6-05/06 — an academy code mints an ACADEMY session only: no management, no platform administration', async () => {
      const { owner, academy: a } = await freshAcademy('a6-mgmt');
      await admin.user.update({
        where: { id: owner.userId },
        data: { isPlatformOwner: true },
      });
      // A body asking for the management surface is ignored: the challenge decides.
      const open = await signInAt(a, owner.email).expect(200);
      const session = await http()
        .post('/auth/otp/verify')
        .set('Host', a.host)
        .send({
          challengeId: open.body.challengeId,
          code: await latestCode(owner.userId),
          rememberDevice: false,
          surface: 'management',
        })
        .expect(200);
      const auth = bearer(session.body.accessToken);
      await http().get(`/academies/${a.id}`).set(auth).expect(403);
      await http().get('/platform-users').set(auth).expect(403);
      await admin.user.update({
        where: { id: owner.userId },
        data: { isPlatformOwner: false },
      });
    });

    it('LS-A6-07/08 — a revoked or expired trust asks for the code again', async () => {
      const { academy: a } = await freshAcademy('a6-revoke');
      const learner = await learnerAt(a, 'a6-revoke-l');
      const cookie = readTrustCookie(await academySession(a, learner.email, true));

      await admin.trustedDevice.updateMany({
        where: { userId: learner.userId },
        data: { revokedAt: new Date() },
      });
      expect(
        (await signInAt(a, learner.email, cookie).expect(200)).body.emailOtpRequired,
      ).toBe(true);

      const cookie2 = readTrustCookie(await academySession(a, learner.email, true));
      await admin.trustedDevice.updateMany({
        where: { userId: learner.userId, revokedAt: null },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(
        (await signInAt(a, learner.email, cookie2).expect(200)).body.emailOtpRequired,
      ).toBe(true);
    });

    it('LS-A6-09 — a password reset revokes academy trust and sessions', async () => {
      const { academy: a } = await freshAcademy('a6-reset');
      const learner = await learnerAt(a, 'a6-reset-l');
      const verified = await academySession(a, learner.email, true);
      const cookie = readTrustCookie(verified);

      const raw = generateOpaqueToken();
      await admin.passwordResetToken.create({
        data: {
          userId: learner.userId,
          tokenHash: hashOpaqueToken(raw),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      await http()
        .post('/auth/password-reset/confirm')
        .send({ token: raw, newPassword: 'reset-password-a6' })
        .expect(200);
      await http().get('/users/me').set(bearer(verified.body.accessToken)).expect(401);
      const again = await signInAt(a, learner.email, cookie, 'reset-password-a6').expect(
        200,
      );
      expect(again.body.emailOtpRequired).toBe(true);
    });

    it('LS-A6-10 — a trust row recorded before academy scoping no longer skips the code', async () => {
      const { academy: a } = await freshAcademy('a6-legacy');
      const learner = await learnerAt(a, 'a6-legacy-l');
      const cookie = readTrustCookie(await academySession(a, learner.email, true));
      await admin.trustedDevice.updateMany({
        where: { userId: learner.userId },
        data: { academyId: null },
      });
      expect(
        (await signInAt(a, learner.email, cookie).expect(200)).body.emailOtpRequired,
      ).toBe(true);
    });

    it('LS-A6-11..13 — learner, instructor, manager and owner each authenticate on their academy website (academy session)', async () => {
      const { owner, academy: a } = await freshAcademy('a6-roles');
      const learner = await learnerAt(a, 'a6-roles-l');
      const manager = await staffAccount('a6-roles-m');
      await seedMembership(admin, a.orgId, manager.userId, 'manager');
      await seedAcademyMember(admin, a.id, manager.userId, 'manager');
      const instructor = await staffAccount('a6-roles-i');
      await seedMembership(admin, a.orgId, instructor.userId, 'instructor');
      await seedAcademyMember(admin, a.id, instructor.userId, 'instructor');

      for (const person of [learner, manager, instructor, owner]) {
        // Each person is a separate browser; the per-IP sign-in budget is an existing control.
        await flushRateLimitKeys();
        const session = await academySession(a, person.email);
        const me = await http()
          .get('/users/me')
          .set(bearer(session.body.accessToken))
          .expect(200);
        expect(me.body.organizations).toEqual([]);
      }
      // Staff roles are untouched: their management sessions still work.
      const mgmt = await http()
        .post('/auth/sign-in')
        .send({ email: manager.email, password: PASSWORD })
        .expect(200);
      await http()
        .get(`/academies/${a.id}`)
        .set(bearer(mgmt.body.accessToken))
        .expect(200);
    });

    it('LS-A6-14/15 — no cross-academy escalation: a B session cannot read A’s roster; A’s roster never shows B', async () => {
      const { owner, academy: a } = await freshAcademy('a6-iso-a');
      const { academy: b } = await freshAcademy('a6-iso-b');
      const learner = await learnerAt(a, 'a6-iso');
      await registerAt(b, learner.email).expect(201);
      const bSession = await academySession(b, learner.email);
      await http()
        .get(`/academies/${a.id}/students`)
        .set(bearer(bSession.body.accessToken))
        .expect(403);

      const roster = await http()
        .get(`/academies/${a.id}/students`)
        .set(bearer(owner.token))
        .expect(200);
      const text = JSON.stringify(roster.body);
      expect(text).not.toContain(b.id);
    });

    it('LS-A6-16/17 — wrong codes are generic and bounded; resend respects its limit', async () => {
      const { academy: a } = await freshAcademy('a6-wrong');
      const learner = await learnerAt(a, 'a6-wrong-l');
      const open = await signInAt(a, learner.email).expect(200);
      const bad = await verifyAt(a.host, open.body.challengeId, '000000');
      expect([401]).toContain(bad.status);
      expect(['errors.auth.otpInvalid', 'errors.auth.otpAttemptsExceeded']).toContain(
        bad.body.error.messageKey,
      );
      expect(JSON.stringify(bad.body)).not.toContain(a.id);

      const early = await http()
        .post('/auth/otp/resend')
        .set('Host', a.host)
        .send({ challengeId: open.body.challengeId });
      expect(early.status).toBe(429);
    });

    it('LS-A6-18 — a newer sign-in on the academy surface supersedes the earlier challenge (existing rule)', async () => {
      const { academy: a } = await freshAcademy('a6-concurrent');
      const learner = await learnerAt(a, 'a6-concurrent-l');
      const first = await signInAt(a, learner.email).expect(200);
      const firstCode = await latestCode(learner.userId);
      await signInAt(a, learner.email).expect(200);
      const stale = await verifyAt(a.host, first.body.challengeId, firstCode).expect(401);
      expect(stale.body.error.messageKey).toBe('errors.auth.otpAttemptsExceeded');
    });

    it('LS-A6-19/20 — management and Platform Owner sign-in are unchanged (management OTP off in this app)', async () => {
      const staff = await staffAccount('a6-mgmt-unchanged');
      expect(staff.token).toEqual(expect.any(String));
      await admin.user.update({
        where: { id: staff.userId },
        data: { isPlatformOwner: true },
      });
      const po = await http()
        .post('/auth/sign-in')
        .send({ email: staff.email, password: PASSWORD })
        .expect(200);
      await http().get('/platform-users').set(bearer(po.body.accessToken)).expect(200);
      await admin.user.update({
        where: { id: staff.userId },
        data: { isPlatformOwner: false },
      });
    });
  });

  // ==================================================================
  // Observability — A1 refusals and A3 revocations are observable
  // ==================================================================

  describe('Plan A observability', () => {
    /** The current value of one labelled sample of a counter in this process. */
    async function sample(
      metric: string,
      labels: Record<string, string>,
    ): Promise<number> {
      const found = METRICS_REGISTRY.getSingleMetric(metric);
      if (!found) return 0;
      const { values } = await found.get();
      const hit = values.find((v) =>
        Object.entries(labels).every(([k, val]) => v.labels[k] === val),
      );
      return hit?.value ?? 0;
    }

    function revocationAudits(userId: string) {
      return admin.auditLogEntry.findMany({
        where: { actorUserId: userId, action: 'auth.sessions.revoked' },
        orderBy: { occurredAt: 'desc' },
      });
    }

    it('LS-OBS-01 — an academy session refused on management, Platform Owner, account and cross-academy routes is counted per reason', async () => {
      const { owner, academy: a } = await freshAcademy('obs-a');
      const { academy: b } = await freshAcademy('obs-b');
      await registerAt(b, owner.email).expect(201);
      const session = await academySession(b, owner.email);
      const auth = bearer(session.body.accessToken);

      const before = {
        management_route: await sample('atlas_auth_surface_denied_total', {
          reason: 'management_route',
        }),
        platform_owner_route: await sample('atlas_auth_surface_denied_total', {
          reason: 'platform_owner_route',
        }),
        account_action: await sample('atlas_auth_surface_denied_total', {
          reason: 'account_action',
        }),
        academy_host_mismatch: await sample('atlas_auth_surface_denied_total', {
          reason: 'academy_host_mismatch',
        }),
      };

      await http().get(`/academies/${a.id}`).set(auth).expect(403);
      // `PlatformOwnerGuard` alone guards this route (platform-users also
      // carries `ManagementSurfaceGuard`, which refuses first).
      await http().get('/platform/announcements').set(auth).expect(403);
      await http().get('/users/me/deletion-plan').set(auth).expect(403);
      await http().get('/learning/overview').set('Host', a.host).set(auth).expect(403);

      for (const reason of Object.keys(before) as (keyof typeof before)[]) {
        const after = await sample('atlas_auth_surface_denied_total', { reason });
        expect({ reason, delta: after - before[reason] }).toEqual({ reason, delta: 1 });
      }

      // An allowed request is not counted.
      const steady = await sample('atlas_auth_surface_denied_total', {
        reason: 'management_route',
      });
      await http().get('/learning/overview').set('Host', b.host).set(auth).expect(200);
      expect(
        await sample('atlas_auth_surface_denied_total', { reason: 'management_route' }),
      ).toBe(steady);
    });

    it('LS-OBS-02 — a password reset records the sessions it ended (metric + audit row)', async () => {
      const person = await staffAccount('obs-reset');
      await http()
        .post('/auth/sign-in')
        .send({ email: person.email, password: PASSWORD })
        .expect(200);
      const before = await sample('atlas_auth_sessions_revoked_total', {
        trigger: 'password_reset',
      });

      const raw = generateOpaqueToken();
      await admin.passwordResetToken.create({
        data: {
          userId: person.userId,
          tokenHash: hashOpaqueToken(raw),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });
      await http()
        .post('/auth/password-reset/confirm')
        .send({ token: raw, newPassword: 'observed-reset-password-1' })
        .expect(200);

      expect(
        await sample('atlas_auth_sessions_revoked_total', { trigger: 'password_reset' }),
      ).toBe(before + 2);
      const audits = await revocationAudits(person.userId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ targetType: 'user', targetId: person.userId });
      expect(audits[0].context).toMatchObject({
        trigger: 'password_reset',
        sessionsRevoked: 2,
      });
    });

    it('LS-OBS-03 — a password change records the sessions it ended (metric + audit row)', async () => {
      const person = await staffAccount('obs-change');
      const before = await sample('atlas_auth_sessions_revoked_total', {
        trigger: 'password_change',
      });
      await http()
        .post('/users/me/password')
        .set(bearer(person.token))
        .send({ currentPassword: PASSWORD, newPassword: 'observed-change-password-1' })
        .expect(200);

      expect(
        await sample('atlas_auth_sessions_revoked_total', { trigger: 'password_change' }),
      ).toBe(before + 1);
      const audits = await revocationAudits(person.userId);
      expect(audits).toHaveLength(1);
      expect(audits[0].context).toMatchObject({
        trigger: 'password_change',
        sessionsRevoked: 1,
      });
    });
  });
});
