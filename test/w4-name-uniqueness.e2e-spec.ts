/**
 * W4 — uniqueness of organization names, academy names and learner names
 * within an academy, end to end against the real AppModule, real Postgres
 * with FORCE RLS and the real definer checks.
 *
 *   - `atlas_name_key()` (SQL, authoritative) agrees with the TypeScript
 *     mirror on the shared corpus.
 *   - Organizations and academies: duplicates refused (case, spacing, Latin
 *     accents, Arabic harakat/tatweel/hamza), empty keys 400, and a parallel
 *     race lets exactly one writer win.
 *   - Learners: interactive admissions (staff add, a proven existing
 *     account's join) refused with an actionable 409; automatic admissions
 *     (new-account registration, sign-in auto-join, purchase) succeed,
 *     exempt, and the clash is audited; a profile rename that clashes is
 *     refused and names only the user's own academies.
 *   - The definer checks return booleans only, and the remediation backup
 *     tables are invisible to the application role.
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
import { uniqueName } from './utils/unique-name';
import { NAME_KEY_CORPUS } from '../src/common/name-uniqueness/name-key.corpus';
import { normalizeNameKey } from '../src/common/name-uniqueness/name-key';
import { EnrollmentsService } from '../src/learning/services/enrollments.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { PrismaService } from '../src/database/prisma.service';

jest.setTimeout(120000);

const PASSWORD = 'correct-horse-battery-w4';

describe('W4 — name uniqueness (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let appPrisma: PrismaService;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    appPrisma = testApp.prisma;
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
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
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
    email = uniqueTestEmail('w4-l'),
  ) {
    return http()
      .post('/auth/register')
      .send({ name, email, password: PASSWORD, academyId });
  }

  async function signInAcademy(email: string, academyId: string) {
    return http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD, surface: 'academy', academyId });
  }

  // -------------------------------------------------------------------
  // Normalization parity
  // -------------------------------------------------------------------

  it('atlas_name_key() and the TypeScript mirror agree on the shared corpus', async () => {
    for (const { label, value, expected } of NAME_KEY_CORPUS) {
      const rows = await admin.$queryRaw<
        { key: string }[]
      >`SELECT atlas_name_key(${value}) AS key`;
      expect({ label, key: rows[0].key }).toEqual({ label, key: expected });
      expect({ label, key: normalizeNameKey(value) }).toEqual({ label, key: expected });
    }
  });

  // -------------------------------------------------------------------
  // Organizations
  // -------------------------------------------------------------------

  describe('organizations (unique platform-wide)', () => {
    it('refuses case, spacing and accent variants with one generic answer', async () => {
      const a = await staff('w4-org-a');
      const b = await staff('w4-org-b');
      const base = uniqueName('Café Élan');
      const created = await http()
        .post('/organizations')
        .set(bearer(a.token))
        .send({ name: `  ${base}  ` })
        .expect(201);
      // The stored display value is trimmed.
      expect(created.body.name).toBe(base);

      for (const variant of [
        base.toUpperCase(),
        base.normalize('NFD').replace(/[̀-ͯ]/g, ''),
        base.replace(' ', ' ​ '),
      ]) {
        const res = await http()
          .post('/organizations')
          .set(bearer(b.token))
          .send({ name: variant })
          .expect(409);
        expect(res.body.error).toMatchObject({
          messageKey: 'errors.organization.nameUnavailable',
          violations: [{ field: 'name' }],
        });
        // Nothing about the holder leaks.
        expect(JSON.stringify(res.body)).not.toContain(created.body.id);
        expect(JSON.stringify(res.body)).not.toContain(created.body.slug);
      }
    });

    it('refuses Arabic harakat / tatweel / hamza variants', async () => {
      const a = await staff('w4-org-ar-a');
      const b = await staff('w4-org-ar-b');
      const tag = uniqueName('x').split(' ')[1];
      await http()
        .post('/organizations')
        .set(bearer(a.token))
        .send({ name: `أكاديمية مُحَمَّد ${tag}` })
        .expect(201);
      const res = await http()
        .post('/organizations')
        .set(bearer(b.token))
        .send({ name: `اكاديمية محـــمد ${tag}` })
        .expect(409);
      expect(res.body.error.messageKey).toBe('errors.organization.nameUnavailable');
    });

    it('answers 400 for a name with nothing comparable', async () => {
      const a = await staff('w4-org-empty');
      const res = await http()
        .post('/organizations')
        .set(bearer(a.token))
        .send({ name: 'َ​ـ' })
        .expect(400);
      expect(res.body.error.messageKey).toBe('errors.validation.nameInvalid');
    });

    it('a parallel race for one name lets exactly one organization win', async () => {
      const name = uniqueName('Race Org');
      const racers = await Promise.all(
        Array.from({ length: 5 }, (_, i) => staff(`w4-org-race-${i}`)),
      );
      const results = await Promise.all(
        racers.map((r) =>
          http().post('/organizations').set(bearer(r.token)).send({ name }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409, 409, 409, 409]);
      for (const loser of results.filter((r) => r.status === 409)) {
        expect(loser.body.error.messageKey).toBe('errors.organization.nameUnavailable');
      }
      const key = normalizeNameKey(name);
      const rows = await admin.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM organizations WHERE name_key = ${key}`;
      expect(Number(rows[0].n)).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // Academies
  // -------------------------------------------------------------------

  describe('academies (unique platform-wide, archived included)', () => {
    it('a provisioning request for a taken name is refused when made', async () => {
      const held = await academyWithOwner('w4-acad-held');
      const other = await academyWithOwner('w4-acad-req');
      const res = await http()
        .post(`/organizations/${other.org.id}/provisioning-requests`)
        .set(bearer(other.owner.token))
        .send({
          academyName: held.academy.name.toUpperCase(),
          requestedSubdomain: `w4req${Date.now().toString(36)}`,
          idempotencyKey: `w4-req-${Date.now()}`,
        })
        .expect(409);
      expect(res.body.error).toMatchObject({
        messageKey: 'errors.academy.nameTaken',
        violations: [{ field: 'academyName' }],
      });
    });

    it('rename and branding rename refuse a name held by another academy (accent / Arabic variants)', async () => {
      const first = await academyWithOwner('w4-acad-a');
      const second = await academyWithOwner('w4-acad-b');
      const tag = uniqueName('x').split(' ')[1];
      const latin = `École Nour ${tag}`;
      const arabic = `أَكاديمية النُّور ${tag}`;
      await http()
        .patch(`/academies/${first.academy.id}`)
        .set(bearer(first.owner.token))
        .send({ name: latin })
        .expect(200);
      await http()
        .patch(`/academies/${first.academy.id}/branding`)
        .set(bearer(first.owner.token))
        .send({ name: arabic })
        .expect(200);
      // Re-saving its own name is never a conflict.
      await http()
        .patch(`/academies/${first.academy.id}`)
        .set(bearer(first.owner.token))
        .send({ name: arabic })
        .expect(200);

      const viaUpdate = await http()
        .patch(`/academies/${second.academy.id}`)
        .set(bearer(second.owner.token))
        .send({ name: `اكاديمية النور ${tag}` })
        .expect(409);
      expect(viaUpdate.body.error).toMatchObject({
        messageKey: 'errors.academy.nameTaken',
        violations: [{ field: 'name' }],
      });

      // The latin name was released by the rename above; take it, then
      // the branding form refuses it to the other academy.
      await http()
        .patch(`/academies/${second.academy.id}`)
        .set(bearer(second.owner.token))
        .send({ name: latin })
        .expect(200);
      const viaBranding = await http()
        .patch(`/academies/${first.academy.id}/branding`)
        .set(bearer(first.owner.token))
        .send({ name: `ecole nour ${tag}` })
        .expect(409);
      expect(viaBranding.body.error.messageKey).toBe('errors.academy.nameTaken');
    });

    it('an archived academy keeps its name', async () => {
      const archived = await academyWithOwner('w4-acad-arch');
      await admin.academy.update({
        where: { id: archived.academy.id },
        data: { status: 'archived' },
      });
      const other = await academyWithOwner('w4-acad-arch-b');
      await http()
        .patch(`/academies/${other.academy.id}`)
        .set(bearer(other.owner.token))
        .send({ name: archived.academy.name })
        .expect(409);
    });

    it('a parallel race of renames to one name lets exactly one academy win', async () => {
      const name = uniqueName('Race Academy');
      const contenders = await Promise.all(
        Array.from({ length: 4 }, (_, i) => academyWithOwner(`w4-acad-race-${i}`)),
      );
      const results = await Promise.all(
        contenders.map((c) =>
          http()
            .patch(`/academies/${c.academy.id}`)
            .set(bearer(c.owner.token))
            .send({ name }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    });
  });

  // -------------------------------------------------------------------
  // Learners
  // -------------------------------------------------------------------

  describe('learners (unique per academy, Model A)', () => {
    // Security review finding 2 — an unauthenticated registration is never
    // refused for a learner name (that answer told anyone whether a named
    // person studies here). The clash is admitted `name_unique_exempt` and
    // surfaces to the account after sign-in (test/w4-security-review).
    it('registration admits a name already held in THIS academy as exempt (Arabic and accent variants), never a 409', async () => {
      const { academy } = await academyWithOwner('w4-learn-reg');
      const other = await academyWithOwner('w4-learn-reg-other');
      const tag = uniqueName('x').split(' ')[1];
      await registerLearner(academy.id, `مُحَمَّد أَحْمَد ${tag}`).expect(201);
      await registerLearner(academy.id, `José Ruiz ${tag}`).expect(201);

      await registerLearner(academy.id, `محـمد احمد ${tag}`).expect(201);
      await registerLearner(academy.id, `JOSE  RUIZ ${tag}`).expect(201);
      // ى/ي are deliberately not folded.
      await registerLearner(academy.id, `مصطفى ${tag}`).expect(201);
      await registerLearner(academy.id, `مصطفي ${tag}`).expect(201);
      // Another academy is unaffected.
      await registerLearner(other.academy.id, `محمد احمد ${tag}`).expect(201);

      const exempt = async (academyId: string, name: string) =>
        (
          await admin.academyStudent.findMany({
            where: { academyId, nameKey: normalizeNameKey(name) },
            orderBy: { joinedAt: 'asc' },
            select: { nameUniqueExempt: true },
          })
        ).map((row) => row.nameUniqueExempt);
      expect(await exempt(academy.id, `محمد احمد ${tag}`)).toEqual([false, true]);
      expect(await exempt(academy.id, `jose ruiz ${tag}`)).toEqual([false, true]);
      expect(await exempt(academy.id, `مصطفى ${tag}`)).toEqual([false]);
      expect(await exempt(academy.id, `مصطفي ${tag}`)).toEqual([false]);
      expect(await exempt(other.academy.id, `محمد احمد ${tag}`)).toEqual([false]);
    });

    it('a parallel registration race admits everyone, with exactly one non-exempt learner', async () => {
      const { academy } = await academyWithOwner('w4-learn-race');
      const name = uniqueName('Race Learner');
      const results = await Promise.all(
        Array.from({ length: 4 }, () => registerLearner(academy.id, name)),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      const key = normalizeNameKey(name);
      const rows = await admin.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM academy_students
        WHERE academy_id = ${academy.id} AND name_key = ${key} AND NOT name_unique_exempt`;
      expect(Number(rows[0].n)).toBe(1);
    });

    it('staff add: a new account and an existing account get their own 409s', async () => {
      const { owner, academy } = await academyWithOwner('w4-learn-staff');
      const name = uniqueName('Staff Added');
      await registerLearner(academy.id, name).expect(201);

      const newAccount = await http()
        .post(`/academies/${academy.id}/students`)
        .set(bearer(owner.token))
        .send({ email: uniqueTestEmail('w4-staff-new'), name: name.toLowerCase() })
        .expect(409);
      expect(newAccount.body.error).toMatchObject({
        messageKey: 'errors.academy.learnerNameTaken',
        violations: [{ field: 'name' }],
      });

      // An existing account elsewhere whose own name clashes here.
      const elsewhere = await academyWithOwner('w4-learn-staff-else');
      const existingEmail = uniqueTestEmail('w4-staff-existing');
      await registerLearner(elsewhere.academy.id, `${name} `, existingEmail).expect(201);
      const existing = await http()
        .post(`/academies/${academy.id}/students`)
        .set(bearer(owner.token))
        // The add form always sends a name (ATO F5 — staff cannot tell an
        // existing account from a new one); for an existing account it is
        // ignored, and the clash is on that account's own name.
        .send({ email: existingEmail, name: 'Typed By Staff' })
        .expect(409);
      expect(existing.body.error).toMatchObject({
        messageKey: 'errors.academy.learnerNameTakenExistingAccount',
        violations: [{ field: 'email' }],
      });
    });

    it('sign-in auto-join NEVER fails on a clash: the row is exempt and the clash audited', async () => {
      const target = await academyWithOwner('w4-learn-autojoin');
      const home = await academyWithOwner('w4-learn-autojoin-home');
      const name = uniqueName('Auto Joiner');
      await registerLearner(target.academy.id, name).expect(201);
      const email = uniqueTestEmail('w4-autojoin');
      await registerLearner(home.academy.id, name, email).expect(201);

      const session = await signInAcademy(email, target.academy.id);
      expect(session.status).toBe(200);
      const userId = session.body.user.id as string;
      const row = await admin.academyStudent.findFirstOrThrow({
        where: { academyId: target.academy.id, userId },
      });
      expect(row.source).toBe('sign_in_join');
      expect(row.nameUniqueExempt).toBe(true);
      const audit = await admin.auditLogEntry.findFirst({
        where: {
          action: 'academy.student.name_clash_exempted',
          academyId: target.academy.id,
          targetId: userId,
        },
      });
      expect(audit?.context).toMatchObject({ source: 'sign_in_join' });
    });

    it('a purchase NEVER fails on a clash: the membership is created exempt', async () => {
      const { org, academy } = await academyWithOwner('w4-learn-purchase');
      const home = await academyWithOwner('w4-learn-purchase-home');
      const name = uniqueName('Buyer');
      await registerLearner(academy.id, name).expect(201);
      const email = uniqueTestEmail('w4-buyer');
      await registerLearner(home.academy.id, name, email).expect(201);
      const buyer = await admin.user.findUniqueOrThrow({ where: { email } });
      const course = await seedCourse(admin, academy.id, uniqueName('W4 Paid Course'), {
        status: 'published',
        visibility: 'public',
      });

      const enrollments = app.get(EnrollmentsService);
      const tenancy = app.get(TenancyContextService);
      await tenancy.runInTenantAndUserContext(org.id, buyer.id, (tx) =>
        enrollments.createEnrollmentInTransaction(tx, buyer.id, course, {
          accessSource: 'order',
          ensureMembership: 'purchase',
        }),
      );

      const row = await admin.academyStudent.findFirstOrThrow({
        where: { academyId: academy.id, userId: buyer.id },
      });
      expect(row.source).toBe('purchase');
      expect(row.nameUniqueExempt).toBe(true);
      expect(
        await admin.enrollment.count({
          where: { studentId: buyer.id, courseId: course.id },
        }),
      ).toBe(1);
      expect(
        await admin.auditLogEntry.count({
          where: { action: 'academy.student.name_clash_exempted', targetId: buyer.id },
        }),
      ).toBe(1);
    });

    it('a profile rename that clashes is refused and lists only the user’s own academies', async () => {
      const a = await academyWithOwner('w4-rename-a');
      const b = await academyWithOwner('w4-rename-b');
      const taken = uniqueName('Taken Name');
      await registerLearner(a.academy.id, taken).expect(201);

      const email = uniqueTestEmail('w4-renamer');
      await registerLearner(a.academy.id, uniqueName('Renamer'), email).expect(201);
      const signedIn = await signInAcademy(email, b.academy.id); // auto-joins B too
      expect(signedIn.status).toBe(200);
      const session = await signInAcademy(email, a.academy.id);
      const token = session.body.accessToken as string;
      const userId = session.body.user.id as string;

      const refused = await http()
        .patch('/users/me')
        .set(bearer(token))
        .send({ name: taken.toUpperCase() })
        .expect(409);
      expect(refused.body.error).toMatchObject({
        messageKey: 'errors.profile.nameTakenInAcademy',
        violations: [{ field: 'name' }],
      });
      expect(refused.body.error.details.academies).toEqual([
        { academyId: a.academy.id, name: a.academy.name },
      ]);
      expect(JSON.stringify(refused.body)).not.toContain(b.academy.id);

      // A free name goes through, and every academy row's key follows.
      const fresh = uniqueName('Fresh Name');
      await http()
        .patch('/users/me')
        .set(bearer(token))
        .send({ name: fresh })
        .expect(200);
      const keys = await admin.academyStudent.findMany({
        where: { userId },
        select: { nameKey: true },
      });
      expect(keys).toHaveLength(2);
      expect(keys.every((k) => k.nameKey === normalizeNameKey(fresh))).toBe(true);
    });
  });

  // -------------------------------------------------------------------
  // The definer checks
  // -------------------------------------------------------------------

  describe('SECURITY DEFINER checks', () => {
    const CHECKS = [
      'organization_name_taken(text)',
      'academy_name_taken(text, text)',
      'academy_learner_name_taken(text, text, text)',
      'academy_learner_admission_name_taken(text, text)',
    ];

    it('return booleans only, run for atlas_app, and are not executable by PUBLIC', async () => {
      for (const signature of CHECKS) {
        const rows = await admin.$queryRaw<
          { result: string; definer: boolean; app: boolean; pub: boolean }[]
        >`
          SELECT pg_get_function_result(${signature}::regprocedure) AS result,
                 p.prosecdef AS definer,
                 has_function_privilege('atlas_app', ${signature}, 'EXECUTE') AS app,
                 has_function_privilege('public', ${signature}, 'EXECUTE') AS pub
            FROM pg_proc p WHERE p.oid = ${signature}::regprocedure`;
        expect({ signature, ...rows[0] }).toEqual({
          signature,
          result: 'boolean',
          definer: true,
          app: true,
          pub: false,
        });
      }
    });

    it('answer across tenants for the application role without exposing a row', async () => {
      const held = await academyWithOwner('w4-definer');
      // The runtime role, with NO tenant context: RLS hides the organization…
      const visible = await appPrisma.organization.count({ where: { id: held.org.id } });
      expect(visible).toBe(0);
      // …but the boolean checks still answer, and only with a boolean.
      const rows = await appPrisma.$queryRaw<{ taken: unknown }[]>`
        SELECT organization_name_taken(atlas_name_key(${held.org.name})) AS taken`;
      expect(rows).toEqual([{ taken: true }]);
      const academyRows = await appPrisma.$queryRaw<{ taken: unknown }[]>`
        SELECT academy_name_taken(atlas_name_key(${held.academy.name}), NULL) AS taken`;
      expect(academyRows).toEqual([{ taken: true }]);
      const free = await appPrisma.$queryRaw<{ taken: unknown }[]>`
        SELECT organization_name_taken(atlas_name_key(${uniqueName('nobody')})) AS taken`;
      expect(free).toEqual([{ taken: false }]);
    });

    it('keeps the remediation backup tables away from the application role', async () => {
      for (const table of [
        'atlas_migration_backups.w4_backup_organization_names',
        'atlas_migration_backups.w4_backup_academy_names',
        'atlas_migration_backups.w4_backup_academy_student_exemptions',
      ]) {
        const rows = await admin.$queryRaw<{ exists: boolean; select: boolean | null }[]>`
          SELECT to_regclass(${table}) IS NOT NULL AS exists,
                 CASE WHEN to_regclass(${table}) IS NULL THEN NULL
                      ELSE has_table_privilege('atlas_app', ${table}, 'SELECT') END AS select`;
        expect(rows[0].exists).toBe(true);
        expect(rows[0].select).toBe(false);
      }
    });
  });
});
