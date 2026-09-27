/**
 * Smart member invitation + smart academy signup — end to end against the
 * real `AppModule`, real Postgres with FORCE RLS, real Redis and the real
 * communications outbox. See docs/SMART_MEMBER_INVITE_AND_ACADEMY_JOIN.md.
 *
 *   SMI-LOOKUP  `GET /academies/:id/member-lookup` — who may ask, what it
 *               answers (and never answers), and its rate limit
 *   SMI-ADD     `POST /academies/:id/{members,instructors,students}` — new,
 *               existing and pending-setup accounts; atomicity; races
 *   SMI-JOIN    `POST /auth/academy-join` — an existing account joins an
 *               academy without being an account-existence oracle
 *
 * Academy hosts are real, connected custom hostnames (`domain_connections`),
 * exactly as in launch-stabilization.e2e-spec.ts. Emails are asserted at the
 * outbox (the processor is inert), which is where "after commit" is decided.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import type { Counter } from 'prom-client';

import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { METRICS_REGISTRY } from '../src/observability/metrics/learning-metrics.service';

jest.setTimeout(120000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-smi';

describe('Smart member invitation + academy join (e2e)', () => {
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

  interface Account {
    readonly email: string;
    readonly userId: string;
    readonly token: string;
  }

  async function staffAccount(label: string): Promise<Account> {
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
      token: signIn.body.accessToken,
    };
  }

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
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.smi.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: host, status: 'connected' },
    });
    return { id: academy.id, orgId: org.id, host };
  }

  async function freshAcademy(label: string, policy?: 'open' | 'invite' | 'approval') {
    const owner = await staffAccount(`${label}-owner`);
    return { owner, academy: await academyOwnedBy(owner.userId, label, policy) };
  }

  function registerAt(a: Academy, email: string, name = 'Learner') {
    return http()
      .post('/auth/register')
      .set('Host', a.host)
      .send({ name, email, password: PASSWORD, academyId: a.id });
  }

  async function learnerAt(a: Academy, label: string, name = 'Learner') {
    const email = uniqueTestEmail(label);
    await registerAt(a, email, name).expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  function lookup(a: Academy, token: string, email: string, role = 'manager') {
    return http()
      .get(`/academies/${a.id}/member-lookup`)
      .query({ email, role })
      .set(bearer(token));
  }

  const ROUTE = {
    manager: 'members',
    instructor: 'instructors',
    student: 'students',
  } as const;

  function add(
    a: Academy,
    token: string,
    role: keyof typeof ROUTE,
    body: { email: string; name?: string },
  ) {
    return http().post(`/academies/${a.id}/${ROUTE[role]}`).set(bearer(token)).send(body);
  }

  function joinAt(a: Academy, email: string, password = PASSWORD, academyId = a.id) {
    return http()
      .post('/auth/academy-join')
      .set('Host', a.host)
      .send({ email, password, academyId });
  }

  /**
   * The values an email was emitted with. The academy name must be the
   * academy's own, never blank — production once rendered "You've been
   * added to  on Atlas" because it was read outside any tenant context.
   */
  async function outboxAcademyName(userId: string, key: string): Promise<unknown> {
    const row = await admin.communicationOutbox.findFirstOrThrow({
      where: { recipientUserId: userId, key },
      orderBy: { createdAt: 'desc' },
    });
    return (row.values as Record<string, unknown> | null)?.academyName;
  }

  async function academyName(id: string): Promise<string> {
    return (await admin.academy.findUniqueOrThrow({ where: { id } })).name;
  }

  async function outboxCount(userId: string, key: string): Promise<number> {
    return admin.communicationOutbox.count({ where: { recipientUserId: userId, key } });
  }

  async function counterValue(
    name: string,
    labels: Record<string, string>,
  ): Promise<number> {
    const metric = METRICS_REGISTRY.getSingleMetric(name) as Counter | undefined;
    if (!metric) return 0;
    const data = await metric.get();
    const hit = data.values.find((v) =>
      Object.entries(labels).every(([k, value]) => v.labels[k] === value),
    );
    return hit?.value ?? 0;
  }

  // ==================================================================
  // Lookup
  // ==================================================================

  describe('SMI-LOOKUP — the staff dialog email check', () => {
    it('SMI-LOOKUP-01 — answers only a status, plus the display name when an account exists', async () => {
      const { owner, academy: a } = await freshAcademy('lk-shape');
      const { academy: other } = await freshAcademy('lk-shape-other');
      const learner = await learnerAt(other, 'lk-shape-learner', 'Ahmed Existing');

      const fresh = await lookup(a, owner.token, uniqueTestEmail('lk-new')).expect(200);
      expect(fresh.body).toEqual({ status: 'new' });

      const existing = await lookup(a, owner.token, learner.email.toUpperCase()).expect(
        200,
      );
      expect(existing.body).toEqual({ status: 'existing', name: 'Ahmed Existing' });
      // Nothing else about the account — no id, email, orgs, academies, roles.
      expect(JSON.stringify(existing.body)).not.toContain(learner.userId);
      expect(JSON.stringify(existing.body)).not.toContain(other.id);
    });

    it('SMI-LOOKUP-02 — pending-setup, already-member and unavailable accounts', async () => {
      const { owner, academy: a } = await freshAcademy('lk-states');

      const invitedEmail = uniqueTestEmail('lk-invited');
      await add(a, owner.token, 'manager', {
        email: invitedEmail,
        name: 'Pending Person',
      }).expect(201);
      // Same academy, same role: already here.
      expect(
        (await lookup(a, owner.token, invitedEmail, 'manager').expect(200)).body,
      ).toEqual({
        status: 'already_member',
      });
      // Same academy, as a learner: the account exists but never finished setup.
      expect(
        (await lookup(a, owner.token, invitedEmail, 'student').expect(200)).body,
      ).toEqual({
        status: 'existing_pending_setup',
        name: 'Pending Person',
      });

      const suspended = await staffAccount('lk-suspended');
      await admin.user.update({
        where: { id: suspended.userId },
        data: { status: 'suspended' },
      });
      expect((await lookup(a, owner.token, suspended.email).expect(200)).body).toEqual({
        status: 'unavailable',
      });
    });

    it('SMI-LOOKUP-03 — refused to everyone who could not perform the matching add', async () => {
      const { owner, academy: a } = await freshAcademy('lk-authz');
      const { owner: otherOwner } = await freshAcademy('lk-authz-other');
      const target = uniqueTestEmail('lk-authz-target');

      // No session at all.
      await http()
        .get(`/academies/${a.id}/member-lookup`)
        .query({ email: target, role: 'manager' })
        .expect(401);

      // Owner of ANOTHER academy.
      await lookup(a, otherOwner.token, target).expect(403);

      // A manager of THIS academy: not the owner.
      const manager = await staffAccount('lk-authz-manager');
      await seedMembership(admin, a.orgId, manager.userId, 'manager');
      await seedAcademyMember(admin, a.id, manager.userId, 'manager');
      const before = await counterValue('atlas_member_lookup_total', {
        result: 'denied',
      });
      await lookup(a, manager.token, target, 'student').expect(403);
      await lookup(a, manager.token, target, 'manager').expect(403);
      expect(await counterValue('atlas_member_lookup_total', { result: 'denied' })).toBe(
        before + 2,
      );

      // An academy-website session of the owner.
      await registerAt(a, owner.email).expect(201);
      const open = await http()
        .post('/auth/sign-in')
        .set('Host', a.host)
        .send({
          email: owner.email,
          password: PASSWORD,
          surface: 'academy',
          academyId: a.id,
        })
        .expect(200);
      const code = await latestCode(owner.userId);
      const session = await http()
        .post('/auth/otp/verify')
        .set('Host', a.host)
        .send({
          challengeId: open.body.challengeId,
          code,
          rememberDevice: false,
          surface: 'academy',
        })
        .expect(200);
      const academySurface = await lookup(a, session.body.accessToken, target);
      expect(academySurface.status).toBe(403);
      expect(academySurface.body.error.messageKey).toBe(
        'errors.auth.managementSurfaceOnly',
      );

      // Malformed input never reaches the service.
      await lookup(a, owner.token, 'not-an-email').expect(400);
      await lookup(a, owner.token, target, 'owner').expect(400);
    });

    it('SMI-LOOKUP-04 — rate-limited per acting user', async () => {
      const { owner, academy: a } = await freshAcademy('lk-rate');
      for (let i = 0; i < 30; i += 1) {
        await lookup(a, owner.token, uniqueTestEmail(`lk-rate-${i}`)).expect(200);
      }
      const limited = await lookup(a, owner.token, uniqueTestEmail('lk-rate-over'));
      expect(limited.status).toBe(429);
      expect(limited.body.error.messageKey).toBe(
        'errors.academy.memberLookupRateLimited',
      );
    });
  });

  // ==================================================================
  // Add
  // ==================================================================

  describe('SMI-ADD — adding staff and learners by email', () => {
    it('SMI-ADD-01 — a new email: one invited account, the membership, and a setup email', async () => {
      const { owner, academy: a } = await freshAcademy('add-new');
      const email = uniqueTestEmail('add-new-mgr');

      const res = await add(a, owner.token, 'manager', {
        email,
        name: 'New Manager',
      }).expect(201);
      expect(res.body.outcome).toBe('invited');

      const user = await admin.user.findUniqueOrThrow({ where: { email } });
      expect(user).toMatchObject({ name: 'New Manager', status: 'invited' });
      expect(
        await admin.academyMember.count({ where: { academyId: a.id, userId: user.id } }),
      ).toBe(1);
      expect(
        await admin.organizationMembership.count({
          where: { organizationId: a.orgId, userId: user.id },
        }),
      ).toBe(1);
      expect(await outboxCount(user.id, 'academy.member.invited')).toBe(1);
      expect(await outboxCount(user.id, 'academy.member.added')).toBe(0);
      expect(await outboxAcademyName(user.id, 'academy.member.invited')).toBe(
        await academyName(a.id),
      );
    });

    it('SMI-ADD-02 — an existing account keeps its name, password and memberships; only this academy is added', async () => {
      const { owner, academy: a } = await freshAcademy('add-existing');
      const { academy: other } = await freshAcademy('add-existing-other');
      const person = await learnerAt(other, 'add-existing-person', 'Real Name');
      const before = await admin.user.findUniqueOrThrow({ where: { id: person.userId } });
      const orgsBefore = await admin.organizationMembership.count({
        where: { userId: person.userId },
      });

      const res = await add(a, owner.token, 'instructor', {
        email: person.email,
        name: 'Typed Different Name',
      }).expect(201);
      expect(res.body.outcome).toBe('added');
      expect(res.body.name).toBe('Real Name');

      const after = await admin.user.findUniqueOrThrow({ where: { id: person.userId } });
      expect(after.name).toBe('Real Name');
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(after.status).toBe('active');
      expect(
        await admin.organizationMembership.count({ where: { userId: person.userId } }),
      ).toBe(orgsBefore + 1);
      expect(
        await admin.academyStudent.count({
          where: { userId: person.userId, academyId: other.id },
        }),
      ).toBe(1);
      expect(await outboxCount(person.userId, 'academy.member.added')).toBe(1);
      expect(await outboxCount(person.userId, 'academy.member.invited')).toBe(0);
      expect(await outboxAcademyName(person.userId, 'academy.member.added')).toBe(
        await academyName(a.id),
      );
      // Still signs in with the password they chose.
      await http()
        .post('/auth/sign-in')
        .send({ email: person.email, password: PASSWORD })
        .expect(200);
    });

    it('SMI-ADD-03 — an existing account added as a learner: a staff_created learner row and an added notice', async () => {
      const { owner, academy: a } = await freshAcademy('add-learner');
      const staff = await staffAccount('add-learner-staff');

      const res = await add(a, owner.token, 'student', { email: staff.email }).expect(
        201,
      );
      expect(res.body.outcome).toBe('added');
      const row = await admin.academyStudent.findFirstOrThrow({
        where: { userId: staff.userId, academyId: a.id },
      });
      expect(row.source).toBe('staff_created');
      expect(await outboxCount(staff.userId, 'academy.learner.added')).toBe(1);
      expect(await outboxAcademyName(staff.userId, 'academy.learner.added')).toBe(
        await academyName(a.id),
      );
      expect(await outboxCount(staff.userId, 'academy.learner.invited')).toBe(0);

      const again = await add(a, owner.token, 'student', { email: staff.email });
      expect(again.status).toBe(409);
      expect(again.body.error.messageKey).toBe('errors.academy.studentAlreadyMember');
    });

    it('SMI-ADD-04 — an account that never finished setup gets a fresh setup email, nothing else changes', async () => {
      const { owner: ownerA, academy: a } = await freshAcademy('add-pending-a');
      const { owner: ownerB, academy: b } = await freshAcademy('add-pending-b');
      const email = uniqueTestEmail('add-pending');
      await add(a, ownerA.token, 'manager', { email, name: 'First Name' }).expect(201);
      const user = await admin.user.findUniqueOrThrow({ where: { email } });

      const res = await add(b, ownerB.token, 'student', {
        email,
        name: 'Second Name',
      }).expect(201);
      expect(res.body.outcome).toBe('reinvited');

      const after = await admin.user.findUniqueOrThrow({ where: { email } });
      expect(after).toMatchObject({ id: user.id, name: 'First Name', status: 'invited' });
      expect(await admin.user.count({ where: { email } })).toBe(1);
      expect(await outboxCount(user.id, 'academy.learner.invited')).toBe(1);
      // The reinvite names the academy that just added them (B), not A.
      expect(await outboxAcademyName(user.id, 'academy.learner.invited')).toBe(
        await academyName(b.id),
      );
    });

    it('SMI-ADD-05 — a new learner needs a name; a suspended account cannot be added', async () => {
      const { owner, academy: a } = await freshAcademy('add-refuse');
      const email = uniqueTestEmail('add-refuse-noname');
      const noName = await add(a, owner.token, 'student', { email });
      expect(noName.status).toBe(400);
      expect(noName.body.error.messageKey).toBe(
        'errors.academy.nameRequiredForNewAccount',
      );
      expect(await admin.user.count({ where: { email } })).toBe(0);

      const noNameStaff = await add(a, owner.token, 'manager', { email });
      expect(noNameStaff.status).toBe(404);

      const suspended = await staffAccount('add-refuse-suspended');
      await admin.user.update({
        where: { id: suspended.userId },
        data: { status: 'suspended' },
      });
      const refused = await add(a, owner.token, 'instructor', { email: suspended.email });
      expect(refused.status).toBe(409);
      expect(refused.body.error.messageKey).toBe('errors.academy.accountUnavailable');
    });

    it('SMI-ADD-06 — a refused add leaves no account behind', async () => {
      const { academy: a } = await freshAcademy('add-orphan');
      const manager = await staffAccount('add-orphan-manager');
      await seedMembership(admin, a.orgId, manager.userId, 'manager');
      await seedAcademyMember(admin, a.id, manager.userId, 'manager');
      const email = uniqueTestEmail('add-orphan-target');

      await add(a, manager.token, 'student', { email, name: 'Nobody' }).expect(403);
      await add(a, manager.token, 'instructor', { email, name: 'Nobody' }).expect(403);
      expect(await admin.user.count({ where: { email } })).toBe(0);

      // Already a member: refused inside the same transaction that would
      // have created the account.
      const { owner, academy: b } = await freshAcademy('add-orphan-b');
      await add(b, owner.token, 'manager', { email: owner.email }).expect(409);
      expect(await admin.user.count({ where: { email: owner.email } })).toBe(1);
    });

    it('SMI-ADD-07 — concurrent adds of the same new email: one account, one membership, never a 500', async () => {
      const { owner, academy: a } = await freshAcademy('add-race');
      const email = uniqueTestEmail('add-race-same');
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          add(a, owner.token, 'student', { email, name: 'Race Person' }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
      expect(await admin.user.count({ where: { email } })).toBe(1);
      const user = await admin.user.findUniqueOrThrow({ where: { email } });
      expect(await admin.academyStudent.count({ where: { userId: user.id } })).toBe(1);
    });

    it('SMI-ADD-08 — the same new email added by two academies at once: one account in both', async () => {
      const { owner: ownerA, academy: a } = await freshAcademy('add-race2-a');
      const { owner: ownerB, academy: b } = await freshAcademy('add-race2-b');
      const email = uniqueTestEmail('add-race2');
      const [ra, rb] = await Promise.all([
        add(a, ownerA.token, 'instructor', { email, name: 'Shared Person' }),
        add(b, ownerB.token, 'student', { email, name: 'Shared Person' }),
      ]);
      expect([ra.status, rb.status]).toEqual([201, 201]);
      expect([ra.body.outcome, rb.body.outcome].sort()).toEqual(['invited', 'reinvited']);
      expect(await admin.user.count({ where: { email } })).toBe(1);
      const user = await admin.user.findUniqueOrThrow({ where: { email } });
      expect(
        await admin.academyMember.count({ where: { userId: user.id, academyId: a.id } }),
      ).toBe(1);
      expect(
        await admin.academyStudent.count({ where: { userId: user.id, academyId: b.id } }),
      ).toBe(1);
    });

    it('SMI-ADD-09 — a learner blocked here cannot be re-added', async () => {
      const { owner, academy: a } = await freshAcademy('add-blocked');
      const learner = await learnerAt(a, 'add-blocked-learner');
      await admin.academyStudent.updateMany({
        where: { userId: learner.userId, academyId: a.id },
        data: { blockedAt: new Date() },
      });
      const res = await add(a, owner.token, 'student', { email: learner.email });
      expect(res.status).toBe(403);
      expect(res.body.error.messageKey).toBe('errors.academy.studentBlocked');
    });
  });

  // ==================================================================
  // Academy join
  // ==================================================================

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

  describe('SMI-JOIN — an existing account joins from the academy signup page', () => {
    it('SMI-JOIN-01 — unknown email, wrong password and invited account get the same answer', async () => {
      const { academy: a } = await freshAcademy('join-generic');
      const { academy: other } = await freshAcademy('join-generic-other');
      const existing = await learnerAt(other, 'join-generic-existing', 'Hidden Name');
      const { owner } = await freshAcademy('join-generic-inviter');
      const invitedEmail = uniqueTestEmail('join-generic-invited');
      const inviterAcademy = await academyOwnedBy(owner.userId, 'join-generic-inv-ac');
      await add(inviterAcademy, owner.token, 'student', {
        email: invitedEmail,
        name: 'Invited Person',
      }).expect(201);

      const answers = [
        await joinAt(a, uniqueTestEmail('join-generic-unknown')),
        await joinAt(a, existing.email, 'not-the-password'),
        await joinAt(a, invitedEmail, 'anything-at-all'),
      ];
      for (const res of answers) {
        expect(res.status).toBe(401);
        expect(res.body.error.messageKey).toBe('errors.auth.invalidCredentials');
        expect(JSON.stringify(res.body)).not.toContain('Hidden Name');
      }
      expect(
        await admin.academyStudent.count({
          where: { userId: existing.userId, academyId: a.id },
        }),
      ).toBe(0);
    });

    it('SMI-JOIN-02 — the right password joins, returns the name, and continues into the emailed-code sign-in', async () => {
      const { academy: a } = await freshAcademy('join-ok');
      const { academy: other } = await freshAcademy('join-ok-other');
      const person = await learnerAt(other, 'join-ok-person', 'Ahmed');
      const before = await counterValue('atlas_academy_join_total', { result: 'joined' });

      const joined = await joinAt(a, person.email).expect(200);
      expect(joined.body).toEqual({
        account: 'existing',
        status: 'active',
        name: 'Ahmed',
      });
      expect(await counterValue('atlas_academy_join_total', { result: 'joined' })).toBe(
        before + 1,
      );
      expect(await admin.user.count({ where: { email: person.email } })).toBe(1);
      expect(
        await admin.academyStudent.count({
          where: { userId: person.userId, academyId: a.id },
        }),
      ).toBe(1);
      expect(await outboxCount(person.userId, 'account.academy.joined')).toBe(1);

      // No session was minted by the join; the sign-in that follows runs
      // under the academy's A6 emailed-code rules.
      expect(joined.body.accessToken).toBeUndefined();
      const open = await http()
        .post('/auth/sign-in')
        .set('Host', a.host)
        .send({
          email: person.email,
          password: PASSWORD,
          surface: 'academy',
          academyId: a.id,
        })
        .expect(200);
      expect(open.body.emailOtpRequired).toBe(true);
      const session = await http()
        .post('/auth/otp/verify')
        .set('Host', a.host)
        .send({
          challengeId: open.body.challengeId,
          code: await latestCode(person.userId),
          rememberDevice: false,
          surface: 'academy',
        })
        .expect(200);
      expect(session.body.accessToken).toBeTruthy();

      const again = await joinAt(a, person.email);
      expect(again.status).toBe(409);
      expect(again.body.error.messageKey).toBe('errors.auth.alreadyLearnerHere');
    });

    it('SMI-JOIN-03 — an approval academy admits the joined account as pending', async () => {
      const { academy: a } = await freshAcademy('join-approval', 'approval');
      const { academy: other } = await freshAcademy('join-approval-other');
      const person = await learnerAt(other, 'join-approval-person', 'Pending Learner');
      const res = await joinAt(a, person.email).expect(200);
      expect(res.body).toEqual({
        account: 'existing',
        status: 'pending',
        name: 'Pending Learner',
      });
    });

    it('SMI-JOIN-04 — refuses another academy than the host it is called on', async () => {
      const { academy: a } = await freshAcademy('join-host-a');
      const { academy: b } = await freshAcademy('join-host-b');
      const { academy: other } = await freshAcademy('join-host-other');
      const person = await learnerAt(other, 'join-host-person');
      const res = await joinAt(a, person.email, PASSWORD, b.id);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(await admin.academyStudent.count({ where: { userId: person.userId } })).toBe(
        1,
      );
    });

    it('SMI-JOIN-05 — shares the sign-in attempt budget for the account', async () => {
      const { academy: a } = await freshAcademy('join-rate');
      const { academy: other } = await freshAcademy('join-rate-other');
      const person = await learnerAt(other, 'join-rate-person');
      let limited: request.Response | undefined;
      for (let i = 0; i < 15; i += 1) {
        const res = await joinAt(a, person.email, `wrong-password-${i}`);
        if (res.status === 429) {
          limited = res;
          break;
        }
        expect(res.status).toBe(401);
      }
      expect(limited?.body.error.messageKey).toBe('errors.auth.rateLimited');
      // The same budget now refuses an ordinary sign-in for the account too.
      await http()
        .post('/auth/sign-in')
        .send({ email: person.email, password: PASSWORD })
        .expect(429);
    });

    it('SMI-JOIN-06 — /auth/register still creates a brand-new learner, and says nothing new for an existing email', async () => {
      const { academy: a } = await freshAcademy('join-register');
      const { academy: other } = await freshAcademy('join-register-other');
      const person = await learnerAt(other, 'join-register-person');

      const fresh = uniqueTestEmail('join-register-new');
      expect((await registerAt(a, fresh).expect(201)).body).toEqual({ account: 'new' });

      const wrong = await http().post('/auth/register').set('Host', a.host).send({
        name: 'X Y',
        email: person.email,
        password: 'another-password',
        academyId: a.id,
      });
      expect(wrong.status).toBe(409);
      expect(wrong.body.error.messageKey).toBe('errors.auth.emailAlreadyRegistered');
    });

    /** Existing account signs in on `a` with the emailed code: returns the access token. */
    async function academySignIn(a: Academy, email: string): Promise<string> {
      const open = await http()
        .post('/auth/sign-in')
        .set('Host', a.host)
        .send({ email, password: PASSWORD, surface: 'academy', academyId: a.id })
        .expect(200);
      if (open.body.accessToken) return open.body.accessToken as string;
      const user = await admin.user.findUniqueOrThrow({ where: { email } });
      const session = await http()
        .post('/auth/otp/verify')
        .set('Host', a.host)
        .send({
          challengeId: open.body.challengeId,
          code: await latestCode(user.id),
          rememberDevice: false,
          surface: 'academy',
        })
        .expect(200);
      return session.body.accessToken as string;
    }

    function summaryAt(a: Academy, token: string) {
      return http()
        .get('/auth/academy-join/summary')
        .set('Host', a.host)
        .set(bearer(token));
    }

    it('SMI-JOIN-07 — other academies are named only to a signed-in session on the academy just joined', async () => {
      const { academy: a } = await freshAcademy('sum-a');
      const { academy: b } = await freshAcademy('sum-b');
      const { academy: c } = await freshAcademy('sum-c');
      const person = await learnerAt(a, 'sum-person', 'Multi Learner');
      await joinAt(b, person.email).expect(200);

      // Before sign-in: nothing.
      await http().get('/auth/academy-join/summary').set('Host', c.host).expect(401);

      // Joining C, then signing in on C: A and B are named — nothing about C
      // itself, nothing an unrelated academy would learn.
      await joinAt(c, person.email).expect(200);
      const cToken = await academySignIn(c, person.email);
      const summary = await summaryAt(c, cToken).expect(200);
      expect([...summary.body.otherAcademies].sort()).toEqual(
        [await academyName(a.id), await academyName(b.id)].sort(),
      );
      expect(JSON.stringify(summary.body)).not.toContain(a.id);

      // The same session on another academy's host: refused (A1) — never a list.
      const cross = await summaryAt(a, cToken);
      expect(cross.status).toBe(403);
      expect(cross.body.error.messageKey).toBe('errors.auth.academyHostMismatch');

      // A management session of the same person: nothing.
      const mgmt = await http()
        .post('/auth/sign-in')
        .send({ email: person.email, password: PASSWORD })
        .expect((res) => expect([200, 403]).toContain(res.status));
      if (mgmt.body.accessToken) {
        expect((await summaryAt(c, mgmt.body.accessToken).expect(200)).body).toEqual({
          otherAcademies: [],
        });
      }

      // Long after the join: nothing (A5 — an academy session is told about
      // its own academy only).
      await admin.academyStudent.updateMany({
        where: { userId: person.userId, academyId: c.id },
        data: { joinedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      });
      expect((await summaryAt(c, cToken).expect(200)).body).toEqual({
        otherAcademies: [],
      });
    });

    it('SMI-JOIN-08 — a staff account joins as a learner; blocked or pending academies are not named', async () => {
      const { owner: staff, academy: a } = await freshAcademy('sum-staff');
      const { academy: b } = await freshAcademy('sum-staff-b');
      const { academy: blockedAt } = await freshAcademy('sum-staff-blocked');
      await registerAt(blockedAt, staff.email).expect(201);
      await admin.academyStudent.updateMany({
        where: { userId: staff.userId, academyId: blockedAt.id },
        data: { blockedAt: new Date() },
      });

      const joined = await joinAt(b, staff.email).expect(200);
      expect(joined.body).toMatchObject({ account: 'existing', status: 'active' });
      const orgsBefore = await admin.organizationMembership.count({
        where: { userId: staff.userId },
      });

      const token = await academySignIn(b, staff.email);
      const summary = await summaryAt(b, token).expect(200);
      // Staff of A, never a learner there; a learner of a blocked academy.
      expect(summary.body.otherAcademies).toEqual([]);
      expect(summary.body.otherAcademies).not.toContain(await academyName(a.id));
      expect(summary.body.otherAcademies).not.toContain(await academyName(blockedAt.id));
      expect(
        await admin.organizationMembership.count({ where: { userId: staff.userId } }),
      ).toBe(orgsBefore);
    });

    it('SMI-JOIN-09 — suspended and deleted accounts: nothing is disclosed before the password, nothing joined', async () => {
      const { academy: a } = await freshAcademy('state-a');
      const { academy: other } = await freshAcademy('state-other');
      const suspended = await learnerAt(other, 'state-suspended', 'Suspended Person');
      const deleted = await learnerAt(other, 'state-deleted', 'Deleted Person');
      await admin.user.update({
        where: { id: suspended.userId },
        data: { status: 'suspended' },
      });
      await admin.user.update({
        where: { id: deleted.userId },
        data: { status: 'deleted' },
      });

      const wrongSuspended = await joinAt(a, suspended.email, 'not-the-password');
      expect(wrongSuspended.status).toBe(401);
      expect(wrongSuspended.body.error.messageKey).toBe('errors.auth.invalidCredentials');

      const rightSuspended = await joinAt(a, suspended.email);
      expect(rightSuspended.status).toBe(403);
      expect(rightSuspended.body.error.messageKey).toBe('errors.auth.accountSuspended');

      const deletedJoin = await joinAt(a, deleted.email);
      expect(deletedJoin.status).toBe(401);
      expect(deletedJoin.body.error.messageKey).toBe('errors.auth.invalidCredentials');

      for (const id of [suspended.userId, deleted.userId]) {
        expect(
          await admin.academyStudent.count({ where: { userId: id, academyId: a.id } }),
        ).toBe(0);
      }
    });
  });
});
