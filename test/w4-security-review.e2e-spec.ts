/**
 * W4 — security review follow-ups, end to end against the real AppModule,
 * real Postgres (FORCE RLS, the W4 triggers and partial unique index) and
 * the 20261104000340 migration.
 *
 *   Finding 1 — account deletion and the learner-name index:
 *     - two learners of ONE academy both delete their accounts: both succeed
 *       (previously the second failed with P2002 → 500), and their
 *       studentships are removed (the documented lifecycle);
 *     - rows that survive deletion anyway (legacy data, any other writer)
 *       are exempt from the index, so a second deletion / re-anonymisation
 *       in the same academy succeeds, and a live learner can rename to the
 *       anonymised name or to the deleted learner's former name.
 *   Finding 2 — no learner-name oracle without login:
 *     - an unauthenticated registration answers identically whether or not
 *       the name is taken (the clash is admitted exempt and audited);
 *     - the clash surfaces only to the signed-in account once its address
 *       is verified (`academies[].nameChangeSuggested`), where a rename to a
 *       still-taken name is an actionable 409 and a free name clears it;
 *     - renames are rate-limited per account.
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
} from './utils/db-admin';
import { uniqueName } from './utils/unique-name';
import { normalizeNameKey } from '../src/common/name-uniqueness/name-key';
import { AccountDeletionService } from '../src/identity/services/account-deletion.service';

jest.setTimeout(120000);

const PASSWORD = 'correct-horse-battery-w4-sec';

describe('W4 — security review follow-ups (e2e)', () => {
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

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function staff(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: uniqueName(label), email, password: PASSWORD })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { email, userId: signIn.body.user.id as string };
  }

  async function academyWithOwner(label: string) {
    const owner = await staff(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({
      where: { id: academy.id },
      data: { status: 'active', registrationPolicy: 'open' },
    });
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { owner, org, academy };
  }

  function registerLearner(
    academyId: string,
    name: string,
    email = uniqueTestEmail('w4s-l'),
  ) {
    return http()
      .post('/auth/register')
      .send({ name, email, password: PASSWORD, academyId });
  }

  async function learner(academyId: string, name: string) {
    const email = uniqueTestEmail('w4s-learner');
    await registerLearner(academyId, name, email).expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  async function signInAcademy(email: string, academyId: string) {
    const res = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD, surface: 'academy', academyId })
      .expect(200);
    return res.body.accessToken as string;
  }

  // -------------------------------------------------------------------
  // Finding 1 — deletion
  // -------------------------------------------------------------------

  describe('account deletion vs the learner-name index (finding 1)', () => {
    it('two learners of one academy both delete their accounts; both succeed and lose their studentships', async () => {
      const { academy } = await academyWithOwner('w4s-del');
      const first = await learner(academy.id, uniqueName('Leaving One'));
      const second = await learner(academy.id, uniqueName('Leaving Two'));
      const deletion = app.get(AccountDeletionService);

      await expect(deletion.deleteOwnAccount(first.userId, {})).resolves.toMatchObject({
        deleted: true,
      });
      await expect(deletion.deleteOwnAccount(second.userId, {})).resolves.toMatchObject({
        deleted: true,
      });

      for (const { userId } of [first, second]) {
        const user = await admin.user.findUniqueOrThrow({ where: { id: userId } });
        expect(user.status).toBe('deleted');
        expect(user.name).toBe('Deleted account');
        expect(await admin.academyStudent.count({ where: { userId } })).toBe(0);
      }
    });

    it('rows that survive deletion are exempt, so a second deletion and a re-anonymisation in one academy succeed', async () => {
      const { academy } = await academyWithOwner('w4s-retained');
      const a = await learner(academy.id, uniqueName('Retained A'));
      const b = await learner(academy.id, uniqueName('Retained B'));

      // Any writer that anonymises without removing the studentship (legacy
      // deletions, scripts): the trigger must keep the key out of the index.
      for (const { userId } of [a, b]) {
        await admin.user.update({
          where: { id: userId },
          data: { name: 'Deleted account', status: 'deleted', deletedAt: new Date() },
        });
      }
      const rows = await admin.academyStudent.findMany({
        where: { academyId: academy.id, userId: { in: [a.userId, b.userId] } },
      });
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.nameUniqueExempt)).toBe(true);
      expect(rows.every((row) => row.nameKey === 'deleted account')).toBe(true);

      // A deleted account renamed again (e.g. a re-anonymisation) still passes.
      await admin.user.update({
        where: { id: a.userId },
        data: { name: 'Deleted Person' },
      });
      await admin.user.update({
        where: { id: b.userId },
        data: { name: 'Deleted Person' },
      });

      // Nothing can bring a deleted account's row back into the index.
      await admin.academyStudent.update({
        where: { id: rows[0].id },
        data: { nameUniqueExempt: false },
      });
      expect(
        (await admin.academyStudent.findUniqueOrThrow({ where: { id: rows[0].id } }))
          .nameUniqueExempt,
      ).toBe(true);
    });

    it('a live learner can rename to the anonymised name and to a deleted learner’s former name', async () => {
      const { academy } = await academyWithOwner('w4s-rename-after');
      const formerName = uniqueName('Former Name');
      const leaving = await learner(academy.id, formerName);
      const other = await learner(academy.id, uniqueName('Leaving Too'));
      const deletion = app.get(AccountDeletionService);
      await deletion.deleteOwnAccount(leaving.userId, {});
      await deletion.deleteOwnAccount(other.userId, {});

      const staying = await learner(academy.id, uniqueName('Staying'));
      const token = await signInAcademy(staying.email, academy.id);
      await http()
        .patch('/users/me')
        .set(bearer(token))
        .send({ name: 'Deleted account' })
        .expect(200);
      await http()
        .patch('/users/me')
        .set(bearer(token))
        .send({ name: formerName })
        .expect(200);
      const row = await admin.academyStudent.findFirstOrThrow({
        where: { academyId: academy.id, userId: staying.userId },
      });
      expect(row.nameKey).toBe(normalizeNameKey(formerName));
      expect(row.nameUniqueExempt).toBe(false);
    });
  });

  // -------------------------------------------------------------------
  // Finding 2 — no oracle
  // -------------------------------------------------------------------

  describe('learner-name clash is never revealed before sign-in (finding 2)', () => {
    it('an unauthenticated registration answers identically for a taken and a free name', async () => {
      const { academy } = await academyWithOwner('w4s-oracle');
      const taken = uniqueName('Nora Haddad');
      await registerLearner(academy.id, taken).expect(201);

      const clash = await registerLearner(academy.id, taken.toUpperCase());
      const free = await registerLearner(academy.id, uniqueName('Someone Else'));
      expect(clash.status).toBe(free.status);
      expect(clash.status).toBe(201);
      expect(clash.body).toEqual(free.body);
      expect(JSON.stringify(clash.body)).not.toMatch(/nameTaken|learnerName/i);

      // An address that already has an account (unproven) answers the same.
      const existingEmail = uniqueTestEmail('w4s-existing');
      await registerLearner(academy.id, uniqueName('Existing'), existingEmail).expect(
        201,
      );
      const decoy = await http().post('/auth/register').send({
        name: taken,
        email: existingEmail,
        password: 'not-the-password-1',
        academyId: academy.id,
      });
      expect(decoy.status).toBe(201);
      expect(decoy.body).toEqual(free.body);

      // The clash was admitted exempt (never refused) and audited for staff.
      const key = normalizeNameKey(taken);
      const rows = await admin.academyStudent.findMany({
        where: { academyId: academy.id, nameKey: key },
        orderBy: { joinedAt: 'asc' },
      });
      expect(rows.map((row) => row.nameUniqueExempt)).toEqual([false, true]);
      expect(
        await admin.auditLogEntry.count({
          where: {
            action: 'academy.student.name_clash_exempted',
            academyId: academy.id,
            targetId: rows[1].userId,
          },
        }),
      ).toBe(1);
    });

    it('surfaces the clash only after verification, then takes a 409 or a free name', async () => {
      const { academy } = await academyWithOwner('w4s-prompt');
      const taken = uniqueName('Sara Ali');
      await registerLearner(academy.id, taken).expect(201);
      const email = uniqueTestEmail('w4s-clasher');
      await registerLearner(academy.id, taken, email).expect(201);
      const user = await admin.user.findUniqueOrThrow({ where: { email } });
      await admin.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: null },
      });

      const token = await signInAcademy(email, academy.id);
      const unverified = await http().get('/users/me').set(bearer(token)).expect(200);
      expect(unverified.body.academies).toHaveLength(1);
      expect(unverified.body.academies[0].nameChangeSuggested).toBeUndefined();

      await admin.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date() },
      });
      const verified = await http().get('/users/me').set(bearer(token)).expect(200);
      expect(verified.body.academies[0]).toMatchObject({
        academyId: academy.id,
        nameChangeSuggested: true,
      });

      // A same-key cosmetic edit of their own name is not refused (the row
      // simply stays exempt and the prompt stays)...
      const cosmetic = await http()
        .patch('/users/me')
        .set(bearer(token))
        .send({ name: `${taken.toLowerCase()} ` })
        .expect(200);
      expect(cosmetic.body.academies[0].nameChangeSuggested).toBe(true);

      // ...while choosing another name that is taken here is the actionable
      // 409, naming only their own academy.
      const otherTaken = uniqueName('Sara Omar');
      await registerLearner(academy.id, otherTaken).expect(201);
      const refused = await http()
        .patch('/users/me')
        .set(bearer(token))
        .send({ name: otherTaken })
        .expect(409);
      expect(refused.body.error).toMatchObject({
        messageKey: 'errors.profile.nameTakenInAcademy',
      });
      expect(refused.body.error.details.academies).toEqual([
        { academyId: academy.id, name: academy.name },
      ]);

      const fresh = uniqueName('Sara Ali Hassan');
      const renamed = await http()
        .patch('/users/me')
        .set(bearer(token))
        .send({ name: fresh })
        .expect(200);
      expect(renamed.body.academies[0].nameChangeSuggested).toBeUndefined();
      const row = await admin.academyStudent.findFirstOrThrow({
        where: { academyId: academy.id, userId: user.id },
      });
      expect(row.nameUniqueExempt).toBe(false);
      expect(row.nameKey).toBe(normalizeNameKey(fresh));

      // The released name is protected again: a new clash is admitted exempt.
      await registerLearner(academy.id, fresh).expect(201);
      expect(
        await admin.academyStudent.count({
          where: {
            academyId: academy.id,
            nameKey: normalizeNameKey(fresh),
            nameUniqueExempt: false,
          },
        }),
      ).toBe(1);
    });

    it('rate-limits renames per account', async () => {
      const { academy } = await academyWithOwner('w4s-rename-rate');
      const me = await learner(academy.id, uniqueName('Rate Renamer'));
      const token = await signInAcademy(me.email, academy.id);
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const res = await http()
          .patch('/users/me')
          .set(bearer(token))
          .send({ name: uniqueName('Rename') });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });
});
