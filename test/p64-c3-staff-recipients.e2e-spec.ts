/**
 * P64 Communications C3 — `academy_notification_recipients`, the
 * SECURITY DEFINER resolver that lets a LEARNER's transaction address an
 * academy's STAFF.
 *
 * WHY IT EXISTS. Events like "a review needs moderating" or "someone is
 * waiting for approval" are produced by a learner and addressed to staff.
 * `emit` runs inside the producer's transaction, in the learner's RLS
 * context, where `academy_members_tenant_select` has no tenant context and
 * `academy_members_self_select` returns only the learner's own row — so
 * the producer cannot discover who to notify. Moving the emit after the
 * commit would break the atomicity the outbox exists for; loosening the
 * table's RLS would let any learner enumerate staff from any query. A
 * narrow definer function is the smallest thing that works.
 *
 * WHAT THESE CASES PIN. That it genuinely works from a learner's context
 * (the whole point), that it returns ONLY user ids, that it respects
 * membership status so a removed moderator stops receiving work items
 * immediately, and — the containment property — that its existence does
 * NOT make `academy_members` itself readable. A definer function is a
 * deliberate hole in RLS; the test that matters is the one proving the
 * hole is exactly the size it was meant to be.
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
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

jest.setTimeout(60000);
const PASSWORD = 'correct-horse-battery';

describe('P64 C3 — academy_notification_recipients (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let tenancy: TenancyContextService;

  let academyId: string;
  let otherAcademyId: string;
  let ownerUserId: string;
  let moderatorUserId: string;
  let instructorUserId: string;
  let removedUserId: string;
  let learnerUserId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    tenancy = app.get(TenancyContextService, { strict: false });

    ownerUserId = await signUp('c3sr-owner');
    moderatorUserId = await signUp('c3sr-moderator');
    instructorUserId = await signUp('c3sr-instructor');
    removedUserId = await signUp('c3sr-removed');
    learnerUserId = await signUp('c3sr-learner');

    const org = await seedOrganizationWithOwner(admin, ownerUserId, 'c3sr-org');
    const academy = await seedAcademy(admin, org.id, 'c3sr-academy');
    academyId = academy.id;
    const otherOrg = await seedOrganizationWithOwner(admin, ownerUserId, 'c3sr-org-b');
    otherAcademyId = (await seedAcademy(admin, otherOrg.id, 'c3sr-academy-b')).id;

    await seedAcademyMember(admin, academyId, ownerUserId, 'owner');
    await seedAcademyMember(admin, academyId, moderatorUserId, 'manager');
    await seedAcademyMember(admin, academyId, instructorUserId, 'instructor');
    const removed = await seedAcademyMember(admin, academyId, removedUserId, 'manager');
    await admin.academyMember.update({
      where: { id: removed.id },
      data: { status: 'inactive' },
    });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function signUp(label: string): Promise<string> {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return signIn.body.user.id as string;
  }

  /** Called exactly as a producer would: inside the LEARNER's own context. */
  function resolveAsLearner(
    id: string,
    roles: readonly string[],
  ): Promise<{ user_id: string }[]> {
    return tenancy.runInUserContext(
      learnerUserId,
      (tx) =>
        tx.$queryRaw<{ user_id: string }[]>`
        SELECT "user_id" FROM academy_notification_recipients(${id}, ${roles}::text[])
      `,
    );
  }

  it('C3-SR-1: resolves the academy’s moderators from a learner’s transaction', async () => {
    const rows = await resolveAsLearner(academyId, ['owner', 'manager']);
    const ids = rows.map((r) => r.user_id).sort();
    expect(ids).toEqual([ownerUserId, moderatorUserId].sort());
  });

  it('C3-SR-2: excludes a member whose membership is no longer active', async () => {
    const ids = (await resolveAsLearner(academyId, ['owner', 'manager'])).map(
      (r) => r.user_id,
    );
    // A deactivated moderator must stop receiving the academy's work items
    // the moment they lose the role, not at the next deploy.
    expect(ids).not.toContain(removedUserId);
  });

  it('C3-SR-3: returns only the roles asked for', async () => {
    const ids = (await resolveAsLearner(academyId, ['instructor'])).map((r) => r.user_id);
    expect(ids).toEqual([instructorUserId]);
  });

  it('C3-SR-4: never crosses academies', async () => {
    const rows = await resolveAsLearner(otherAcademyId, ['owner', 'manager']);
    expect(rows).toEqual([]);
  });

  it('C3-SR-5: an unknown academy or an empty role list resolves to nobody', async () => {
    expect(await resolveAsLearner('no-such-academy', ['owner'])).toEqual([]);
    expect(await resolveAsLearner(academyId, [])).toEqual([]);
  });

  it('C3-SR-6: returns USER IDS ONLY — no name, email or membership metadata', async () => {
    const rows = await resolveAsLearner(academyId, ['owner']);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0])).toEqual(['user_id']);
  });

  it('C3-SR-7: CONTAINMENT — the function does not make academy_members readable', async () => {
    // The whole justification for a definer function is that the hole is
    // one statement wide. If a learner could read the table directly, the
    // function would not have been needed and the RLS policy would be
    // broken anyway.
    const direct = await tenancy.runInUserContext(
      learnerUserId,
      (tx) =>
        tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "academy_members" WHERE "academy_id" = ${academyId}`,
    );
    expect(direct).toEqual([]);
  });

  it('C3-SR-8: the resolver cannot be used to write anything', async () => {
    // Declared STABLE, so Postgres itself refuses a write inside it. This
    // pins that the declaration is not quietly dropped in a later edit.
    const [{ provolatile }] = await admin.$queryRaw<{ provolatile: string }[]>`
      SELECT "provolatile"::text FROM pg_proc WHERE proname = 'academy_notification_recipients'
    `;
    expect(provolatile).toBe('s');
  });

  it('C3-SR-9: PUBLIC cannot execute it — only the application role', async () => {
    const [{ has }] = await admin.$queryRaw<{ has: boolean }[]>`
      SELECT has_function_privilege(
        'public', 'academy_notification_recipients(text, text[])', 'EXECUTE'
      ) AS has
    `;
    expect(has).toBe(false);
  });
});
