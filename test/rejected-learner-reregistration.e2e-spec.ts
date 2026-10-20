/**
 * Fix round (20 Oct 2026, team) — a REJECTED learner can come back, and a
 * manual enrollment never pretends to give access it cannot.
 *
 *   RJ-REG   the reject dialog says "They can register again": registering
 *            again (sign-up with the account's password, or the explicit
 *            academy-join) puts the SAME membership row back under the
 *            academy's CURRENT registration policy — pending under
 *            approval (a new work item for the moderators), active under
 *            open, active with a claimed invite under invite-only (refused
 *            without one). A blocked learner stays refused; a learner who
 *            is still pending or active is "already a learner" as before.
 *   RJ-STAFF staff can still approve a rejected learner, or add them again
 *            from the add-student dialog; never past a block.
 *   RJ-ENR   a manual enrollment is refused (409 studentNotApproved) for a
 *            pending or rejected learner — learning access needs an active
 *            membership — and works once they are approved.
 *
 * Real `AppModule`, Postgres with FORCE RLS (the learner's own context has
 * no UPDATE policy on `academy_students`; the re-application goes through
 * the `academy_student_reapply` definer), real communications outbox.
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
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { uniqueName } from './utils/unique-name';

jest.setTimeout(120000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-rejoin';

type Policy = 'open' | 'invite' | 'approval';

describe('Rejected learners and manual enrollment (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
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
    readonly host: string;
    readonly ownerUserId: string;
    readonly ownerToken: string;
  }

  /** An academy with its own connected custom hostname and a signed-in owner. */
  async function freshAcademy(label: string, policy: Policy): Promise<Academy> {
    const email = uniqueTestEmail(`${label}-owner`);
    await http()
      .post('/auth/register')
      .send({ name: `${label} owner`, email, password: PASSWORD })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    const ownerUserId = signIn.body.user.id as string;
    const org = await seedOrganizationWithOwner(admin, ownerUserId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({
      where: { id: academy.id },
      data: { status: 'active', registrationPolicy: policy },
    });
    await seedAcademyMember(admin, academy.id, ownerUserId, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.rejoin.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: host, status: 'connected' },
    });
    return {
      id: academy.id,
      host,
      ownerUserId,
      ownerToken: signIn.body.accessToken as string,
    };
  }

  function registerAt(a: Academy, email: string, extra: Record<string, unknown> = {}) {
    return http()
      .post('/auth/register')
      .set('Host', a.host)
      .send({
        name: uniqueName('Learner'),
        email,
        password: PASSWORD,
        academyId: a.id,
        ...extra,
      });
  }

  function joinAt(a: Academy, email: string) {
    return http()
      .post('/auth/academy-join')
      .set('Host', a.host)
      .send({ email, password: PASSWORD, academyId: a.id });
  }

  const setPolicy = (a: Academy, policy: Policy) =>
    http()
      .patch(`/academies/${a.id}/registration-policy`)
      .set(bearer(a.ownerToken))
      .send({ registrationPolicy: policy })
      .expect(200);

  const decide = (
    a: Academy,
    userId: string,
    action: 'approve' | 'reject' | 'block' | 'unblock',
  ) =>
    http()
      .post(`/academies/${a.id}/students/${userId}/${action}`)
      .set(bearer(a.ownerToken))
      .send({});

  const membership = (a: Academy, userId: string) =>
    admin.academyStudent.findUniqueOrThrow({
      where: { academyId_userId: { academyId: a.id, userId } },
    });

  const awaitingApprovalCount = (a: Academy) =>
    admin.communicationOutbox.count({
      where: {
        recipientUserId: a.ownerUserId,
        key: 'roster.student.awaiting_approval',
        academyId: a.id,
      },
    });

  /** A learner who registered at `a` (approval policy) and was rejected. */
  async function rejectedLearner(a: Academy, label: string) {
    const email = uniqueTestEmail(label);
    const first = await registerAt(a, email).expect(201);
    expect(first.body).toEqual({ account: 'new' });
    const userId = (await admin.user.findUniqueOrThrow({ where: { email } })).id;
    expect((await membership(a, userId)).status).toBe('pending');
    await decide(a, userId, 'reject').expect(200);
    expect((await membership(a, userId)).status).toBe('inactive');
    return { email, userId };
  }

  // ==================================================================
  // RJ-REG — registering again after a rejection
  // ==================================================================

  describe('RJ-REG — a rejected learner registers again', () => {
    it('RJ-REG-01 — approval policy: back to pending on the SAME row, and the moderators get a NEW work item', async () => {
      const a = await freshAcademy('rj-approval', 'approval');
      const learner = await rejectedLearner(a, 'rj-approval-learner');
      const before = await membership(a, learner.userId);
      const workItemsBefore = await awaitingApprovalCount(a);
      expect(workItemsBefore).toBe(1);

      const again = await registerAt(a, learner.email).expect(201);
      expect(again.body).toEqual({ account: 'existing', status: 'pending' });

      const after = await membership(a, learner.userId);
      expect(after.id).toBe(before.id);
      expect(after.status).toBe('pending');
      expect(after.blockedAt).toBeNull();
      expect(after.joinedAt.getTime()).toBeGreaterThanOrEqual(before.joinedAt.getTime());
      expect(
        await admin.academyStudent.count({ where: { userId: learner.userId } }),
      ).toBe(1);
      // The second application is not swallowed by the first one's dedupe key.
      expect(await awaitingApprovalCount(a)).toBe(2);

      const audit = await admin.auditLogEntry.findFirst({
        where: {
          academyId: a.id,
          action: 'academy.student.joined',
          targetId: learner.userId,
        },
        orderBy: { occurredAt: 'desc' },
      });
      expect(audit?.context).toMatchObject({
        existingAccount: true,
        status: 'pending',
        afterRejection: true,
      });

      // Still pending → registering a third time is "already a learner".
      const third = await registerAt(a, learner.email).expect(409);
      expect(third.body.error.messageKey).toBe('errors.auth.alreadyLearnerHere');
    });

    it('RJ-REG-02 — open policy (changed after the rejection): active straight away', async () => {
      const a = await freshAcademy('rj-open', 'approval');
      const learner = await rejectedLearner(a, 'rj-open-learner');
      await setPolicy(a, 'open');

      const again = await joinAt(a, learner.email).expect(200);
      expect(again.body).toMatchObject({ account: 'existing', status: 'active' });
      const after = await membership(a, learner.userId);
      expect(after.status).toBe('active');
      expect(after.source).toBe('self_signup');
      // No approval work item for an open admission.
      expect(await awaitingApprovalCount(a)).toBe(1);

      // Active now → joining again is "already a learner".
      const twice = await joinAt(a, learner.email).expect(409);
      expect(twice.body.error.messageKey).toBe('errors.auth.alreadyLearnerHere');
    });

    it('RJ-REG-03 — invite-only policy: refused without an invite, active with a claimed one', async () => {
      const a = await freshAcademy('rj-invite', 'approval');
      const learner = await rejectedLearner(a, 'rj-invite-learner');
      await setPolicy(a, 'invite');

      const refused = await registerAt(a, learner.email).expect(403);
      expect(refused.body.error.messageKey).toBe('errors.auth.inviteRequired');
      expect((await membership(a, learner.userId)).status).toBe('inactive');

      const invite = await http()
        .post(`/academies/${a.id}/invites`)
        .set(bearer(a.ownerToken))
        .send({ maxUses: 1, expiresInDays: 7 })
        .expect(201);
      const again = await registerAt(a, learner.email, {
        inviteToken: invite.body.token,
      }).expect(201);
      expect(again.body).toEqual({ account: 'existing', status: 'active' });
      const after = await membership(a, learner.userId);
      expect(after.status).toBe('active');
      expect(after.source).toBe('invite');
    });

    it('RJ-REG-04 — a rejected learner who was then BLOCKED stays refused', async () => {
      const a = await freshAcademy('rj-blocked', 'approval');
      const learner = await rejectedLearner(a, 'rj-blocked-learner');
      await decide(a, learner.userId, 'block').expect(200);

      const viaRegister = await registerAt(a, learner.email).expect(403);
      expect(viaRegister.body.error.messageKey).toBe('errors.auth.academyAccessBlocked');
      const viaJoin = await joinAt(a, learner.email).expect(403);
      expect(viaJoin.body.error.messageKey).toBe('errors.auth.academyAccessBlocked');

      const after = await membership(a, learner.userId);
      expect(after.status).toBe('inactive');
      expect(after.blockedAt).not.toBeNull();
    });

    it('RJ-REG-05 — the definer reopens only the CALLER’s rejected, unblocked row', async () => {
      const a = await freshAcademy('rj-definer', 'approval');
      const rejected = await rejectedLearner(a, 'rj-definer-rejected');
      const blocked = await rejectedLearner(a, 'rj-definer-blocked');
      await decide(a, blocked.userId, 'block').expect(200);

      const call = (userId: string | null, status = 'pending', source = 'self_signup') =>
        admin.$transaction(async (tx) => {
          if (userId) {
            await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
          }
          const rows = await tx.$queryRaw<{ id: string | null }[]>`
            SELECT academy_student_reapply(${a.id}, ${status}, ${source}, NULL) AS id`;
          return rows[0]?.id ?? null;
        });

      // No user context, someone else's row, a blocked row: nothing.
      expect(await call(null)).toBeNull();
      expect(await call(a.ownerUserId)).toBeNull();
      expect(await call(blocked.userId)).toBeNull();
      // Only a self-registration outcome can be written.
      await expect(call(rejected.userId, 'inactive')).rejects.toThrow();
      await expect(call(rejected.userId, 'pending', 'staff_created')).rejects.toThrow();
      expect((await membership(a, rejected.userId)).status).toBe('inactive');

      const id = await call(rejected.userId);
      expect(id).toBe((await membership(a, rejected.userId)).id);
      expect((await membership(a, rejected.userId)).status).toBe('pending');
      // Pending now: a second call has nothing to reopen.
      expect(await call(rejected.userId, 'active')).toBeNull();
      expect((await membership(a, blocked.userId)).blockedAt).not.toBeNull();
    });
  });

  // ==================================================================
  // RJ-STAFF — staff decide again
  // ==================================================================

  describe('RJ-STAFF — staff can still admit a rejected learner', () => {
    it('RJ-STAFF-01 — Approve works on a rejected learner; not on a blocked one or an active one', async () => {
      const a = await freshAcademy('rj-approve', 'approval');
      const learner = await rejectedLearner(a, 'rj-approve-learner');

      const approved = await decide(a, learner.userId, 'approve').expect(200);
      expect(approved.body.membershipStatus).toBe('active');
      expect((await membership(a, learner.userId)).status).toBe('active');

      const again = await decide(a, learner.userId, 'approve').expect(409);
      expect(again.body.error.messageKey).toBe('errors.academy.studentNotPending');

      const blocked = await rejectedLearner(a, 'rj-approve-blocked');
      await decide(a, blocked.userId, 'block').expect(200);
      const refused = await decide(a, blocked.userId, 'approve').expect(409);
      expect(refused.body.error.messageKey).toBe('errors.academy.studentNotPending');
      expect((await membership(a, blocked.userId)).status).toBe('inactive');
    });

    it('RJ-STAFF-02 — the add-student dialog treats a rejected learner as addable and re-admits the same row', async () => {
      const a = await freshAcademy('rj-add', 'approval');
      const learner = await rejectedLearner(a, 'rj-add-learner');
      const before = await membership(a, learner.userId);

      const lookup = await http()
        .get(`/academies/${a.id}/member-lookup`)
        .query({ email: learner.email, role: 'student' })
        .set(bearer(a.ownerToken))
        .expect(200);
      expect(lookup.body).toEqual({ status: 'new' });

      await http()
        .post(`/academies/${a.id}/students`)
        .set(bearer(a.ownerToken))
        .send({ email: learner.email, name: 'Fixture Learner' })
        .expect(201);
      const after = await membership(a, learner.userId);
      expect(after.id).toBe(before.id);
      expect(after.status).toBe('active');
      expect(after.source).toBe('staff_created');

      // Active now: a current learner again.
      const twice = await http()
        .post(`/academies/${a.id}/students`)
        .set(bearer(a.ownerToken))
        .send({ email: learner.email, name: 'Fixture Learner' })
        .expect(409);
      expect(twice.body.error.messageKey).toBe('errors.academy.studentAlreadyMember');
    });

    it('RJ-STAFF-03 — a blocked rejected learner is still refused by the add-student dialog', async () => {
      const a = await freshAcademy('rj-add-blocked', 'approval');
      const learner = await rejectedLearner(a, 'rj-add-blocked-learner');
      await decide(a, learner.userId, 'block').expect(200);

      const lookup = await http()
        .get(`/academies/${a.id}/member-lookup`)
        .query({ email: learner.email, role: 'student' })
        .set(bearer(a.ownerToken))
        .expect(200);
      expect(lookup.body).toEqual({ status: 'already_member' });
      const refused = await http()
        .post(`/academies/${a.id}/students`)
        .set(bearer(a.ownerToken))
        .send({ email: learner.email, name: 'Fixture Learner' })
        .expect(403);
      expect(refused.body.error.messageKey).toBe('errors.academy.studentBlocked');
      expect((await membership(a, learner.userId)).status).toBe('inactive');
    });
  });

  // ==================================================================
  // RJ-ENR — manual enrollment needs an approved learner
  // ==================================================================

  describe('RJ-ENR — manual enrollment', () => {
    it('RJ-ENR-01 — refused for a pending and for a rejected learner; allowed once approved', async () => {
      const a = await freshAcademy('rj-enroll', 'approval');
      const course = await seedCourse(admin, a.id, 'rj-enroll-course', {
        status: 'published',
      });
      const enroll = (userId: string) =>
        http()
          .post(`/academies/${a.id}/students/${userId}/enrollments`)
          .set(bearer(a.ownerToken))
          .send({ courseId: course.id });

      const pendingEmail = uniqueTestEmail('rj-enroll-pending');
      await registerAt(a, pendingEmail).expect(201);
      const pendingId = (
        await admin.user.findUniqueOrThrow({ where: { email: pendingEmail } })
      ).id;
      const rejected = await rejectedLearner(a, 'rj-enroll-rejected');

      for (const userId of [pendingId, rejected.userId]) {
        const refused = await enroll(userId).expect(409);
        expect(refused.body.error.messageKey).toBe('errors.academy.studentNotApproved');
        expect(
          await admin.enrollment.count({
            where: { studentId: userId, courseId: course.id },
          }),
        ).toBe(0);
      }

      await decide(a, pendingId, 'approve').expect(200);
      const granted = await enroll(pendingId).expect(201);
      expect(granted.body).toMatchObject({ courseId: course.id, isActive: true });
    });
  });
});
