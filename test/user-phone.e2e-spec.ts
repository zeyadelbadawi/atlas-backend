/**
 * Phone number on sign-up and profile (docs/USER_PHONE.md) — against real
 * Postgres + Redis.
 *
 *   PHONE-01  registration without a phone still works (older sign-up page)
 *   PHONE-02  registration with a phone stores the SERVER's E.164 + country,
 *             unverified, in `user_phones` (never on `users`)
 *   PHONE-03  invalid numbers are refused field-by-field, before anything is
 *             created; a duplicate-email registration with a bad number gets
 *             the SAME 400 (no enumeration); a shared number is fine
 *   PHONE-04  profile: read, add, change, remove; `/users/me` never carries it
 *   PHONE-05  changing the number clears verification (service AND trigger);
 *             re-saving the same number keeps it
 *   PHONE-06  phone changes are rate-limited per account
 *   PHONE-07  account deletion erases the number
 *   PHONE-08  learner sign-up on an academy website stores it; the academy's
 *             owner sees it on no roster response
 *   PHONE-09  RLS: FORCE RLS on `user_phones`; another account, an academy's
 *             owner (tenant context) and the Platform Owner read/write none
 *             of it; the table refuses a non-E.164 value
 *   PHONE-10  the audit trail records the change without the number
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Prisma, PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { deletionCodeFor } from './utils/account-deletion';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { PHONE_CHANGE_LIMIT } from '../src/identity/phone/user-phone.service';

jest.setTimeout(120000);
const PASSWORD = 'correct-horse-battery-phone';

describe('User phone number (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let tenancy: TenancyContextService;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    // Field violations exactly as production answers them (main.ts).
    const testApp = await createTestApp({ fieldViolations: true });
    app = testApp.app;
    admin = createAdminPrisma();
    tenancy = app.get(TenancyContextService, { strict: false });
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  /**
   * Numbers are unique (20261110000400). The fixed numbers these tests
   * assert on are freed before each test, so reruns against a long-lived
   * local database do not collide with an earlier run's accounts.
   */
  const FIXED_NUMBERS = [
    '+201001234567',
    '+201101234567',
    '+201012345678',
    '+201201234567',
    '+966501234567',
    ...[0, 1, 2, 3, 4, 5, 6].map((d) => `+20100123456${d}`),
  ];

  beforeEach(async () => {
    await flushRateLimitKeys();
    await admin.userPhone.deleteMany({ where: { phoneE164: { in: FIXED_NUMBERS } } });
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function register(label: string, extra: Record<string, unknown> = {}) {
    const email = uniqueTestEmail(label);
    const res = await http()
      .post('/auth/register')
      .send({ name: `Phone ${label}`, email, password: PASSWORD, ...extra });
    return { email, res };
  }

  async function signedIn(label: string, extra: Record<string, unknown> = {}) {
    const { email, res } = await register(label, extra);
    expect(res.status).toBe(201);
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

  const phoneRow = (userId: string) => admin.userPhone.findUnique({ where: { userId } });

  it('PHONE-01 — registration without a phone still works and stores none', async () => {
    const { email, res } = await register('p01');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ account: 'new' });
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    expect(await phoneRow(user.id)).toBeNull();
  });

  it('PHONE-02 — registration stores the server-normalised E.164, unverified, off the directory row', async () => {
    const { email, res } = await register('p02', {
      // As typed: national form with spaces and Arabic-Indic digits.
      phoneNumber: '٠١٠ ٠١٢٣ ٤٥٦٧',
      phoneCountry: 'eg',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ account: 'new' });
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    expect(await phoneRow(user.id)).toEqual(
      expect.objectContaining({
        phoneE164: '+201001234567',
        countryCode: 'EG',
        verifiedAt: null,
      }),
    );
    // Not a column of the directory row.
    expect(Object.keys(user).some((key) => /phone/i.test(key))).toBe(false);
  });

  it.each([
    [
      { phoneNumber: '0223456789', phoneCountry: 'EG' },
      'phoneNumber',
      'validation:phoneNotMobile',
    ],
    [
      { phoneNumber: '+966501234567', phoneCountry: 'EG' },
      'phoneNumber',
      'validation:phoneCountryMismatch',
    ],
    [
      { phoneNumber: 'call 01001234567', phoneCountry: 'EG' },
      'phoneNumber',
      'validation:invalidPhone',
    ],
    [
      { phoneNumber: '01001234567', phoneCountry: 'XX' },
      'phoneCountry',
      'validation:invalidPhoneCountry',
    ],
    [{ phoneNumber: '01001234567' }, 'phoneCountry', 'validation:required'],
    [{ phoneCountry: 'EG' }, 'phoneNumber', 'validation:required'],
  ])(
    'PHONE-03 — refuses %j (%s: %s) and creates nothing',
    async (phone, field, messageKey) => {
      const { email, res } = await register('p03', phone);
      expect(res.status).toBe(400);
      expect(res.body.error.kind).toBe('validation');
      expect(res.body.error.violations).toEqual(
        expect.arrayContaining([expect.objectContaining({ field, messageKey })]),
      );
      expect(await admin.user.findUnique({ where: { email } })).toBeNull();
    },
  );

  it('PHONE-03 — an existing address with a bad number gets the very same 400 (no enumeration); a number in use is refused without saying whose', async () => {
    const first = await register('p03-existing', {
      phoneNumber: '01001234567',
      phoneCountry: 'EG',
    });
    expect(first.res.status).toBe(201);
    const bad = { phoneNumber: '0223456789', phoneCountry: 'EG' };
    const existing = await http()
      .post('/auth/register')
      .send({ name: 'Again', email: first.email, password: PASSWORD, ...bad });
    const fresh = await register('p03-fresh', bad);
    expect(existing.status).toBe(400);
    expect(fresh.res.status).toBe(400);
    expect(existing.body.error.violations).toEqual(fresh.res.body.error.violations);

    // One account per number: a second account with the same number (in
    // any notation) is refused with "already in use" — nothing about whose.
    const sibling = await register('p03-sibling', {
      phoneNumber: '+20 100 123 4567',
      phoneCountry: 'EG',
    });
    expect(sibling.res.status).toBe(409);
    expect(sibling.res.body.error.messageKey).toBe('errors.auth.phoneTaken');
    expect(sibling.res.body.error.violations).toEqual([
      { field: 'phoneNumber', messageKey: 'validation:phoneTaken' },
    ]);
    expect(JSON.stringify(sibling.res.body)).not.toContain(first.email);
    expect(await admin.user.findUnique({ where: { email: sibling.email } })).toBeNull();

    // The account that holds the number may enter it again (an existing
    // learner signing up at another academy): answered like a new address.
    const fresh2 = await register('p03-fresh2', {
      phoneNumber: '01001234566',
      phoneCountry: 'EG',
    });
    expect(fresh2.res.status).toBe(201);
    const again = await http().post('/auth/register').send({
      name: 'Again',
      email: first.email,
      password: PASSWORD,
      phoneNumber: '01001234567',
      phoneCountry: 'EG',
    });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(fresh2.res.body);

    // The profile refuses someone else's number the same way, and keeps the old one.
    const other = await signedIn('p03-other', {
      phoneNumber: '01001234565',
      phoneCountry: 'EG',
    });
    const taken = await http()
      .put('/users/me/phone')
      .set(bearer(other.token))
      .send({ phoneNumber: '01001234567', phoneCountry: 'EG' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.messageKey).toBe('errors.auth.phoneTaken');
    expect(JSON.stringify(taken.body)).not.toContain(first.email);
    expect((await phoneRow(other.userId))?.phoneE164).toBe('+201001234565');
  });

  it('PHONE-04 — the profile reads, adds, changes and removes the number; /users/me never carries it', async () => {
    const a = await signedIn('p04');
    const empty = await http().get('/users/me/phone').set(bearer(a.token)).expect(200);
    expect(empty.body).toEqual({
      phone: null,
      verification: { available: false, reason: 'disabled' },
    });

    const added = await http()
      .put('/users/me/phone')
      .set(bearer(a.token))
      .send({ phoneNumber: '050 123 4567', phoneCountry: 'SA' })
      .expect(200);
    expect(added.body.phone).toEqual(
      expect.objectContaining({
        e164: '+966501234567',
        country: 'SA',
        callingCode: '966',
        nationalNumber: '501234567',
        verified: false,
      }),
    );
    expect(added.body.phone.verifiedAt).toBeUndefined();

    const read = await http().get('/users/me/phone').set(bearer(a.token)).expect(200);
    expect(read.body.phone.e164).toBe('+966501234567');

    // Server-side validation on the profile path too.
    const refused = await http()
      .put('/users/me/phone')
      .set(bearer(a.token))
      .send({ phoneNumber: '0112345678', phoneCountry: 'SA' })
      .expect(400);
    expect(refused.body.error.violations).toEqual([
      { field: 'phoneNumber', messageKey: 'validation:phoneNotMobile' },
    ]);
    // Unknown fields (e.g. a client trying to set verification) are refused.
    await http()
      .put('/users/me/phone')
      .set(bearer(a.token))
      .send({ phoneNumber: '0501234567', phoneCountry: 'SA', verifiedAt: new Date() })
      .expect(400);

    const me = await http().get('/users/me').set(bearer(a.token)).expect(200);
    expect(JSON.stringify(me.body)).not.toContain('501234567');

    const removed = await http()
      .delete('/users/me/phone')
      .set(bearer(a.token))
      .expect(200);
    expect(removed.body.phone).toBeNull();
    expect(await phoneRow(a.userId)).toBeNull();
    // Removing again is a harmless no-op.
    await http().delete('/users/me/phone').set(bearer(a.token)).expect(200);

    await http().get('/users/me/phone').expect(401);
  });

  it('PHONE-05 — a different number is unverified again; the same number keeps its verification', async () => {
    const a = await signedIn('p05', { phoneNumber: '01001234567', phoneCountry: 'EG' });
    const verifiedAt = new Date();
    await admin.userPhone.update({ where: { userId: a.userId }, data: { verifiedAt } });

    const same = await http()
      .put('/users/me/phone')
      .set(bearer(a.token))
      .send({ phoneNumber: '+201001234567', phoneCountry: 'EG' })
      .expect(200);
    expect(same.body.phone.verified).toBe(true);
    expect((await phoneRow(a.userId))?.verifiedAt).toEqual(verifiedAt);

    const changed = await http()
      .put('/users/me/phone')
      .set(bearer(a.token))
      .send({ phoneNumber: '01101234567', phoneCountry: 'EG' })
      .expect(200);
    expect(changed.body.phone).toEqual(
      expect.objectContaining({ e164: '+201101234567', verified: false }),
    );
    expect((await phoneRow(a.userId))?.verifiedAt).toBeNull();

    // The database enforces the same rule for any writer that forgets it.
    await admin.userPhone.update({ where: { userId: a.userId }, data: { verifiedAt } });
    await admin.userPhone.update({
      where: { userId: a.userId },
      data: { phoneE164: '+201201234567' },
    });
    expect((await phoneRow(a.userId))?.verifiedAt).toBeNull();
  });

  it('PHONE-06 — phone changes are rate-limited per account', async () => {
    const a = await signedIn('p06');
    const numbers = [
      '01001234560',
      '01001234561',
      '01001234562',
      '01001234563',
      '01001234564',
      '01001234565',
      '01001234566',
      '01001234567',
    ];
    const statuses: number[] = [];
    for (const phoneNumber of numbers.slice(0, PHONE_CHANGE_LIMIT.max + 1)) {
      const res = await http()
        .put('/users/me/phone')
        .set(bearer(a.token))
        .send({ phoneNumber, phoneCountry: 'EG' });
      statuses.push(res.status);
      if (res.status === 429)
        expect(res.body.error.messageKey).toBe('errors.auth.rateLimited');
    }
    expect(statuses.slice(0, PHONE_CHANGE_LIMIT.max)).toEqual(
      Array(PHONE_CHANGE_LIMIT.max).fill(200),
    );
    expect(statuses[PHONE_CHANGE_LIMIT.max]).toBe(429);
    // Another account is unaffected.
    const b = await signedIn('p06-other');
    await http()
      .put('/users/me/phone')
      .set(bearer(b.token))
      .send({ phoneNumber: '01001234567', phoneCountry: 'EG' })
      .expect(200);
  });

  it('PHONE-07 — deleting the account erases the number', async () => {
    const a = await signedIn('p07', { phoneNumber: '01001234567', phoneCountry: 'EG' });
    expect(await phoneRow(a.userId)).not.toBeNull();
    const { challengeId, code } = await deletionCodeFor(app, admin, a.token);
    await http()
      .post('/users/me/delete')
      .set(bearer(a.token))
      .send({ confirm: true, challengeId, code })
      .expect(200);
    expect((await admin.user.findUniqueOrThrow({ where: { id: a.userId } })).status).toBe(
      'deleted',
    );
    expect(await phoneRow(a.userId)).toBeNull();
  });

  /** An academy with its own connected hostname, owned by a signed-in staff account. */
  async function academyWithOwner(label: string) {
    const owner = await signedIn(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({
      where: { id: academy.id },
      data: { status: 'active', registrationPolicy: 'open' },
    });
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.phone.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: host, status: 'connected' },
    });
    return { owner, orgId: org.id, academyId: academy.id, host };
  }

  it('PHONE-08 — an academy learner sign-up stores the number; owner and Platform Owner see it, an instructor or outsider never', async () => {
    const a = await academyWithOwner('p08');
    const email = uniqueTestEmail('p08-learner');
    await http()
      .post('/auth/register')
      .set('Host', a.host)
      .send({
        name: `Phone Learner ${Date.now()}`,
        email,
        password: PASSWORD,
        academyId: a.academyId,
        phoneNumber: '0101 234 5678',
        phoneCountry: 'EG',
      })
      .expect(201);
    const learner = await admin.user.findUniqueOrThrow({ where: { email } });
    expect((await phoneRow(learner.id))?.phoneE164).toBe('+201012345678');

    // The learner manages it from the academy website session.
    const signIn = await http()
      .post('/auth/sign-in')
      .set('Host', a.host)
      .send({ email, password: PASSWORD, surface: 'academy', academyId: a.academyId })
      .expect(200);
    const own = await http()
      .get('/users/me/phone')
      .set('Host', a.host)
      .set(bearer(signIn.body.accessToken))
      .expect(200);
    expect(own.body.phone.e164).toBe('+201012345678');

    const roster = await http()
      .get(`/academies/${a.academyId}/students`)
      .set(bearer(a.owner.token))
      .set('X-Academy-Id', a.academyId);
    const detail = await http()
      .get(`/academies/${a.academyId}/students/${learner.id}`)
      .set(bearer(a.owner.token))
      .set('X-Academy-Id', a.academyId);
    // The academy owner sees the student's number on the roster and detail.
    expect(roster.status).toBe(200);
    const item = roster.body.items.find(
      (row: { userId: string }) => row.userId === learner.id,
    );
    expect(item.phone).toEqual({ e164: '+201012345678', country: 'EG' });
    expect(detail.status).toBe(200);
    expect(detail.body.student.phone).toEqual({ e164: '+201012345678', country: 'EG' });

    // An instructor of the academy, or an outsider, gets nothing from the
    // SQL reader — it decides from app.current_user_id, not from the caller.
    const instructor = await signedIn('p08-instructor');
    await seedAcademyMember(admin, a.academyId, instructor.userId, 'instructor');
    const outsider = await signedIn('p08-outsider');
    for (const viewer of [instructor.userId, outsider.userId, learner.id]) {
      const rows = await tenancy.runInUserContext(
        viewer,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM academy_student_phones(${a.academyId}, ARRAY[${learner.id}]::text[])`,
      );
      expect(rows).toEqual([]);
      const platformRows = await tenancy.runInUserContext(
        viewer,
        (tx) =>
          tx.$queryRaw<
            unknown[]
          >`SELECT * FROM platform_student_phones(ARRAY[${learner.id}]::text[])`,
      );
      expect(platformRows).toEqual([]);
    }

    // The Platform Owner sees it on the platform user view — and only for
    // academy students (the academy owner is not one: no number shown).
    const po = await signedIn('p08-po');
    await admin.user.update({
      where: { id: po.userId },
      data: { isPlatformOwner: true },
    });
    const poView = await http()
      .get(`/platform-users/${learner.id}`)
      .set(bearer(po.token))
      .expect(200);
    expect(poView.body.phone).toEqual({ e164: '+201012345678', country: 'EG' });
    const ownerView = await http()
      .get(`/platform-users/${a.owner.userId}`)
      .set(bearer(po.token))
      .expect(200);
    expect(ownerView.body.phone).toBeNull();
  });

  it('PHONE-09 — RLS: only the account itself can read or write its number', async () => {
    const a = await academyWithOwner('p09');
    const learner = await signedIn('p09-learner', {
      phoneNumber: '01001234567',
      phoneCountry: 'EG',
    });
    const other = await signedIn('p09-other');
    const platformOwner = await signedIn('p09-po');
    await admin.user.update({
      where: { id: platformOwner.userId },
      data: { isPlatformOwner: true },
    });
    // Make the learner a student of the academy, so the owner's tenant
    // context genuinely covers them.
    await seedAcademyStudent(admin, a.academyId, learner.userId);

    const [table] = await admin.$queryRaw<{ rls: boolean; force: boolean }[]>`
      SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force
        FROM pg_class c WHERE c.relname = 'user_phones' AND c.relkind = 'r'`;
    expect(table).toEqual({ rls: true, force: true });
    const open = await admin.$queryRaw<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies
       WHERE tablename = 'user_phones' AND (qual = 'true' OR with_check = 'true')`;
    expect(open).toEqual([]);

    const select = (tx: Prisma.TransactionClient) =>
      tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "user_phones" WHERE "user_id" = ${learner.userId}`.then(
        (rows) => rows[0].n,
      );

    expect(await tenancy.runInUserContext(learner.userId, select)).toBe(1);
    expect(await tenancy.runWithoutContext(select)).toBe(0);
    expect(await tenancy.runInUserContext(other.userId, select)).toBe(0);
    expect(await tenancy.runInUserContext(platformOwner.userId, select)).toBe(0);
    expect(await tenancy.runInTenantAndUserContext(a.orgId, a.owner.userId, select)).toBe(
      0,
    );

    // Nobody else can change or delete it, or plant one for the learner.
    const updated = await tenancy.runInUserContext(
      other.userId,
      (tx) =>
        tx.$executeRaw`UPDATE "user_phones" SET "phone_e164" = '+201111111111' WHERE "user_id" = ${learner.userId}`,
    );
    const deleted = await tenancy.runInTenantAndUserContext(
      a.orgId,
      a.owner.userId,
      (tx) =>
        tx.$executeRaw`DELETE FROM "user_phones" WHERE "user_id" = ${learner.userId}`,
    );
    expect(updated).toBe(0);
    expect(deleted).toBe(0);
    await expect(
      tenancy.runInUserContext(
        platformOwner.userId,
        (tx) =>
          tx.$executeRaw`INSERT INTO "user_phones" ("user_id", "phone_e164", "country_code", "updated_at")
                       VALUES (${other.userId}, '+201001234567', 'EG', now())`,
      ),
    ).rejects.toThrow();
    expect((await phoneRow(learner.userId))?.phoneE164).toBe('+201001234567');
    expect(await phoneRow(other.userId)).toBeNull();

    // The table itself refuses anything but E.164 and an alpha-2 country.
    await expect(
      admin.userPhone.create({
        data: { userId: other.userId, phoneE164: '01001234567', countryCode: 'EG' },
      }),
    ).rejects.toThrow();
    await expect(
      admin.userPhone.create({
        data: { userId: other.userId, phoneE164: '+201001234567', countryCode: 'eg' },
      }),
    ).rejects.toThrow();
  });

  it('PHONE-10 — the audit trail records the change, never the number', async () => {
    const a = await signedIn('p10', { phoneNumber: '01001234567', phoneCountry: 'EG' });
    await http()
      .put('/users/me/phone')
      .set(bearer(a.token))
      .send({ phoneNumber: '0501234567', phoneCountry: 'SA' })
      .expect(200);
    await http().delete('/users/me/phone').set(bearer(a.token)).expect(200);
    const entries = await admin.auditLogEntry.findMany({
      where: { targetId: a.userId, action: { startsWith: 'account.phone.' } },
      orderBy: { occurredAt: 'asc' },
    });
    expect(entries.map((entry) => entry.action)).toEqual([
      'account.phone.updated',
      'account.phone.removed',
    ]);
    expect(entries[0].context).toEqual({
      change: 'changed',
      country: 'SA',
      previousCountry: 'EG',
      verificationCleared: false,
    });
    expect(entries[1].context).toEqual({ country: 'SA', wasVerified: false });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('501234567');
    expect(serialized).not.toContain('1001234567');
  });
});
