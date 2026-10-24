/**
 * Atlas mobile app (B4) — consent records, against real Postgres + Redis.
 *
 *   CONSENT-01  registration without `consents` still works and stores none
 *               (the web's request is unchanged)
 *   CONSENT-02  registration with `consents` stores terms, privacy and 13+
 *               with the versions and source sent
 *   CONSENT-03  invalid consents are refused before anything is created:
 *               ageConfirmed other than true, bad version, unknown source,
 *               unknown field
 *   CONSENT-04  GET/POST /users/me/consents: own account only, latest wins,
 *               append-only
 *   CONSENT-05  signed out → 401
 *   CONSENT-06  RLS: FORCE RLS; another account's context reads, writes and
 *               deletes none of it; no UPDATE path exists
 *   CONSENT-07  account deletion erases the records; the export lists them
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { deletionCodeFor } from './utils/account-deletion';
import { assemblePrivacyExport } from '../src/privacy-requests/services/privacy-export.assembler';

jest.setTimeout(120000);
const PASSWORD = 'correct-horse-battery-consent';

const CONSENTS = {
  source: 'ios',
  termsVersion: 'terms-2026-10',
  privacyVersion: 'privacy-2026-10',
  ageConfirmed: true,
};

describe('User consents (e2e, B4)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let tenancy: TenancyContextService;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
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

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function register(label: string, extra: Record<string, unknown> = {}) {
    const email = uniqueTestEmail(label);
    const res = await http()
      .post('/auth/register')
      .send({ name: `Consent ${label}`, email, password: PASSWORD, ...extra });
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

  const rows = (userId: string) =>
    admin.userConsent.findMany({ where: { userId }, orderBy: { kind: 'asc' } });

  it('CONSENT-01 — registration without consents stores none', async () => {
    const { email, res } = await register('c01');
    expect(res.status).toBe(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    expect(await rows(user.id)).toEqual([]);
  });

  it('CONSENT-02 — registration with consents stores all three kinds', async () => {
    const { email, res } = await register('c02', { consents: CONSENTS });
    expect(res.status).toBe(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    const stored = await rows(user.id);
    expect(stored.map((r) => [r.kind, r.version, r.source])).toEqual([
      ['age_13_plus', 'age-13-plus-v1', 'ios'],
      ['privacy', 'privacy-2026-10', 'ios'],
      ['terms', 'terms-2026-10', 'ios'],
    ]);
  });

  it.each([
    ['ageConfirmed false', { ...CONSENTS, ageConfirmed: false }],
    ['ageConfirmed missing', { source: 'ios', termsVersion: 't1', privacyVersion: 'p1' }],
    ['bad version', { ...CONSENTS, termsVersion: 'terms 2026<script>' }],
    ['unknown source', { ...CONSENTS, source: 'desktop' }],
    ['unknown field', { ...CONSENTS, marketing: true }],
  ])('CONSENT-03 — %s is refused and creates no account', async (_label, consents) => {
    const { email, res } = await register(`c03-${Math.random()}`, { consents });
    expect(res.status).toBe(400);
    expect(await admin.user.findUnique({ where: { email } })).toBeNull();
  });

  it('CONSENT-04 — own consents: read, append, latest wins', async () => {
    const me = await signedIn('c04');
    const empty = await http()
      .get('/users/me/consents')
      .set(bearer(me.token))
      .expect(200);
    expect(empty.body).toEqual({ terms: null, privacy: null, age_13_plus: null });

    await http()
      .post('/users/me/consents')
      .set(bearer(me.token))
      .send({ ...CONSENTS, source: 'android', termsVersion: 'terms-2026-09' })
      .expect(201);
    const latest = await http()
      .post('/users/me/consents')
      .set(bearer(me.token))
      .send(CONSENTS)
      .expect(201);
    expect(latest.body.terms).toMatchObject({ version: 'terms-2026-10', source: 'ios' });
    expect(latest.body.age_13_plus).toMatchObject({ version: 'age-13-plus-v1' });
    // Append-only: both acceptances are kept.
    expect((await rows(me.userId)).filter((r) => r.kind === 'terms')).toHaveLength(2);

    await http()
      .post('/users/me/consents')
      .set(bearer(me.token))
      .send({ ...CONSENTS, ageConfirmed: false })
      .expect(400);
  });

  it('CONSENT-05 — signed out is refused', async () => {
    await http().get('/users/me/consents').expect(401);
    await http().post('/users/me/consents').send(CONSENTS).expect(401);
  });

  it('CONSENT-06 — RLS: another account sees and writes none; rows cannot be changed', async () => {
    const owner = await signedIn('c06a', { consents: CONSENTS });
    const other = await signedIn('c06b');

    const forcing = await admin.$queryRaw<{ relforcerowsecurity: boolean }[]>`
      SELECT relforcerowsecurity FROM pg_class WHERE relname = 'user_consents'`;
    expect(forcing[0]?.relforcerowsecurity).toBe(true);

    const seen = await tenancy.runInUserContext(other.userId, (tx) =>
      tx.userConsent.findMany({ where: { userId: owner.userId } }),
    );
    expect(seen).toEqual([]);

    await expect(
      tenancy.runInUserContext(other.userId, (tx) =>
        tx.userConsent.create({
          data: { userId: owner.userId, kind: 'terms', version: 'x1', source: 'web' },
        }),
      ),
    ).rejects.toThrow();

    const deleted = await tenancy.runInUserContext(other.userId, (tx) =>
      tx.userConsent.deleteMany({ where: { userId: owner.userId } }),
    );
    expect(deleted.count).toBe(0);

    // No UPDATE policy: even the owner's own context rewrites nothing.
    const updated = await tenancy.runInUserContext(owner.userId, (tx) =>
      tx.userConsent.updateMany({
        where: { userId: owner.userId },
        data: { version: 'x2' },
      }),
    );
    expect(updated.count).toBe(0);
    expect(await rows(owner.userId)).toHaveLength(3);
  });

  it('CONSENT-07 — deleting the account erases the records', async () => {
    const me = await signedIn('c07', { consents: CONSENTS });
    expect(await rows(me.userId)).toHaveLength(3);
    const { challengeId, code } = await deletionCodeFor(app, admin, me.token);
    await http()
      .post('/users/me/delete')
      .set(bearer(me.token))
      .send({ confirm: true, challengeId, code })
      .expect(200);
    expect(await rows(me.userId)).toEqual([]);
  });

  it('CONSENT-07b — the data export lists them', async () => {
    const me = await signedIn('c07b', { consents: CONSENTS });
    const bundle = await tenancy.runInUserContext(me.userId, (tx) =>
      assemblePrivacyExport(tx, me.userId),
    );
    expect(bundle.account.consents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'terms',
          version: 'terms-2026-10',
          source: 'ios',
        }),
        expect.objectContaining({ kind: 'age_13_plus', version: 'age-13-plus-v1' }),
      ]),
    );
  });
});
