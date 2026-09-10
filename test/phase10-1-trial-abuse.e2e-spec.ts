/**
 * Phase 10.1 — Free-Trial anti-abuse suite (P101-TRIAL-001..018).
 *
 * THE HOLE THIS CLOSES. Before Phase 10.1, every newly created
 * Organization was granted a 3-day trial unconditionally, and any
 * authenticated user may create any number of Organizations. Verified
 * against the running application: one account collected three trials in
 * under a second, with no change of email, device, browser, IP or
 * network. No account recreation and no client-side evasion were even
 * required — the hole was pure server-side logic.
 *
 * WHAT "BLOCKED" MEANS HERE. A refused trial does NOT refuse anything
 * else. The organization is created normally and the redemption request
 * itself returns 200 — with `started: false` — because "you have already
 * used your trial" is an ordinary business outcome, not an error. The
 * subscription simply keeps `trialEndsAt: null`. So these tests assert on
 * whether a USABLE trial resulted, never on a 4xx status, which would be
 * testing the wrong thing.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED. That two accounts belong to one
 * human. No technical system can establish that from network or device
 * signals, and this suite does not pretend otherwise. It asserts the
 * practical bar: farming trials costs a genuinely new, deliverable,
 * non-disposable mailbox every time.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';
import { trialSubjectHash } from '../src/plans/utils/trial-subject.util';

const PASSWORD = 'correct-horse-battery';

describe('Phase 10.1 Free-Trial anti-abuse (e2e) — P101-TRIAL-001..018', () => {
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

  /** Registers and signs in, returning a usable access token. */
  async function signUp(email: string): Promise<string> {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Trial Tester', email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return signIn.body.accessToken;
  }

  /**
   * Creates an Organization and then EXPLICITLY attempts to redeem a
   * trial for it.
   *
   * Phase 10.2 removed the automatic trial that used to come with
   * Organization creation, so "create a workspace and try to get a trial"
   * is now two calls rather than one. Every anti-abuse assertion in this
   * file is unchanged and still means exactly what it did before — the
   * only difference is that the trial is now asked for, which is the
   * whole point of the new product flow.
   *
   * The returned shape mirrors a supertest response so the call sites
   * below keep reading `.body.id`.
   */
  async function createOrganization(
    accessToken: string,
    name: string,
  ): Promise<{ status: number; body: { id: string; name: string } }> {
    const created = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name })
      .expect(201);

    // Explicit, confirmed redemption. A refusal here is a normal business
    // outcome (200 with `started: false`), not an error — the assertions
    // check whether a USABLE trial resulted.
    await request(app.getHttpServer())
      .post(`/organizations/${created.body.id}/subscription/trial`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ confirm: true });

    return {
      status: created.status,
      body: { id: created.body.id, name: created.body.name },
    };
  }

  /**
   * Whether the organization ended up with a trial the user can actually
   * use. Read straight from the database rather than the API so the
   * assertion cannot be satisfied by a presentation-layer accident.
   */
  async function hasUsableTrial(organizationId: string): Promise<boolean> {
    const subscription = await admin.tenantSubscription.findUnique({
      where: { organizationId },
      select: { trialEndsAt: true },
    });
    if (!subscription?.trialEndsAt) return false;
    return subscription.trialEndsAt.getTime() > Date.now();
  }

  it('P101-TRIAL-001 — the first organization for a fresh subject receives a real trial', async () => {
    const token = await signUp(uniqueTestEmail('t001'));
    const org = await createOrganization(token, `T001 ${Date.now()}`);

    expect(await hasUsableTrial(org.body.id)).toBe(true);
  });

  it('P101-TRIAL-002 — the SAME user creating more organizations gets no further trial', async () => {
    // The exact abuse that succeeded before Phase 10.1.
    const token = await signUp(uniqueTestEmail('t002'));

    const first = await createOrganization(token, `T002 a ${Date.now()}`);
    const second = await createOrganization(token, `T002 b ${Date.now()}`);
    const third = await createOrganization(token, `T002 c ${Date.now()}`);

    expect(await hasUsableTrial(first.body.id)).toBe(true);
    expect(await hasUsableTrial(second.body.id)).toBe(false);
    expect(await hasUsableTrial(third.body.id)).toBe(false);
  });

  it('P101-TRIAL-003 — refusing the trial still creates a fully working organization', async () => {
    // A refused trial must never break onboarding. This is the
    // regression guard for the transaction-poisoning bug found during
    // implementation, where a unique violation aborted the caller's
    // transaction and the organization was never created at all.
    const token = await signUp(uniqueTestEmail('t003'));
    await createOrganization(token, `T003 a ${Date.now()}`);

    const second = await createOrganization(token, `T003 b ${Date.now()}`);

    expect(second.body.id).toBeTruthy();
    expect(second.body.name).toContain('T003 b');
    // The subscription row still exists — the organization is complete,
    // just without a usable trial.
    const subscription = await admin.tenantSubscription.findUnique({
      where: { organizationId: second.body.id },
    });
    expect(subscription).toBeTruthy();
    expect(await hasUsableTrial(second.body.id)).toBe(false);
  });

  it('P101-TRIAL-004 — a brand-new, unrelated subject is NOT blocked by someone else', async () => {
    // The false-positive guard. Anti-abuse that blocks legitimate new
    // customers is worse than no anti-abuse at all.
    const firstToken = await signUp(uniqueTestEmail('t004-a'));
    await createOrganization(firstToken, `T004 a ${Date.now()}`);

    const secondToken = await signUp(uniqueTestEmail('t004-b'));
    const org = await createOrganization(secondToken, `T004 b ${Date.now()}`);

    expect(await hasUsableTrial(org.body.id)).toBe(true);
  });

  it('P101-TRIAL-005 — a NEW ACCOUNT using a plus-address alias of the same mailbox gets no trial', async () => {
    // One stamp, evaluated once: two `Date.now()` calls can land on
    // different milliseconds and would silently make these unrelated
    // addresses, turning the whole test into a no-op.
    const stamp = Date.now();
    const base = `t005-${stamp}@gmail.com`;
    const alias = `t005-${stamp}+promo@gmail.com`;
    // Same mailbox, different address string, genuinely different User row.
    // Asserted directly so the test fails loudly if canonicalization ever
    // stops collapsing plus-tags, rather than quietly passing.
    expect(trialSubjectHash(alias)).toBe(trialSubjectHash(base));

    const baseToken = await signUp(base);
    const baseOrg = await createOrganization(baseToken, `T005 base ${Date.now()}`);
    expect(await hasUsableTrial(baseOrg.body.id)).toBe(true);

    const aliasToken = await signUp(alias);
    const aliasOrg = await createOrganization(aliasToken, `T005 alias ${Date.now()}`);
    expect(await hasUsableTrial(aliasOrg.body.id)).toBe(false);
  });

  it('P101-TRIAL-006 — dot-aliasing on a dot-insensitive provider gets no second trial', async () => {
    const stamp = Date.now();
    const plain = `t006x${stamp}@gmail.com`;
    // Dots sprinkled through the same local part. Gmail delivers both to
    // one mailbox, so canonicalization must collapse them together.
    const dotted = `t.0.0.6.x${stamp}@gmail.com`;

    // Asserted unconditionally. An earlier draft guarded the second half
    // behind an `if` comparing the two hashes, which would have let the
    // test pass silently while proving nothing the day canonicalization
    // broke.
    expect(trialSubjectHash(dotted)).toBe(trialSubjectHash(plain));

    const plainToken = await signUp(plain);
    const plainOrg = await createOrganization(plainToken, `T006 a ${stamp}`);
    expect(await hasUsableTrial(plainOrg.body.id)).toBe(true);

    const dottedToken = await signUp(dotted);
    const dottedOrg = await createOrganization(dottedToken, `T006 b ${stamp}`);
    expect(await hasUsableTrial(dottedOrg.body.id)).toBe(false);
  });

  it('P101-TRIAL-007 — dots on a dot-SENSITIVE provider are two different subjects', async () => {
    // The counterpart false-positive guard: collapsing dots everywhere
    // would merge two genuinely different colleagues at one company.
    const stamp = Date.now();
    expect(trialSubjectHash(`first.last${stamp}@atlas.test`)).not.toBe(
      trialSubjectHash(`firstlast${stamp}@atlas.test`),
    );
  });

  it('P101-TRIAL-008 — CONCURRENT organization creation yields exactly one trial', async () => {
    // The race the unique index exists to win. Six simultaneous requests,
    // no application-level lock anywhere in the path.
    const token = await signUp(uniqueTestEmail('t008'));
    const stamp = Date.now();

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        createOrganization(token, `T008 ${stamp} ${i}`),
      ),
    );

    const created = responses.filter((r) => r.status === 201).map((r) => r.body.id);
    expect(created.length).toBeGreaterThan(1);

    const withTrial = await Promise.all(created.map((id) => hasUsableTrial(id)));
    expect(withTrial.filter(Boolean)).toHaveLength(1);
  });

  it('P101-TRIAL-009 — exactly one redemption row exists per subject, ever', async () => {
    const email = uniqueTestEmail('t009');
    const token = await signUp(email);
    const stamp = Date.now();

    await createOrganization(token, `T009 a ${stamp}`);
    await createOrganization(token, `T009 b ${stamp}`);
    await createOrganization(token, `T009 c ${stamp}`);

    const rows = await admin.trialRedemption.findMany({
      where: { subjectHash: trialSubjectHash(email) },
    });
    expect(rows).toHaveLength(1);
  });

  it('P101-TRIAL-010 — the redemption survives deletion of the organization that consumed it', async () => {
    // "Delete everything and start again" must not reset eligibility.
    const email = uniqueTestEmail('t010');
    const token = await signUp(email);
    const org = await createOrganization(token, `T010 ${Date.now()}`);
    expect(await hasUsableTrial(org.body.id)).toBe(true);

    await admin.organization.delete({ where: { id: org.body.id } });

    const redemption = await admin.trialRedemption.findUnique({
      where: { subjectHash: trialSubjectHash(email) },
    });
    // Row still there, link severed rather than cascaded away.
    expect(redemption).toBeTruthy();
    expect(redemption?.organizationId).toBeNull();

    // And the subject still cannot get another trial.
    const again = await createOrganization(token, `T010 again ${Date.now()}`);
    expect(await hasUsableTrial(again.body.id)).toBe(false);
  });

  it('P101-TRIAL-011 — the redemption survives deletion of the USER who redeemed it', async () => {
    const email = uniqueTestEmail('t011');
    const token = await signUp(email);
    const org = await createOrganization(token, `T011 ${Date.now()}`);

    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    // The application has no account-deletion endpoint, and the database
    // additionally refuses to drop a user while audit entries reference
    // them. Clearing those first makes this the most aggressive wipe the
    // schema physically permits — a stronger test than any real deletion
    // flow could be.
    await admin.auditLogEntry.deleteMany({ where: { actorUserId: user.id } });
    await admin.organization.delete({ where: { id: org.body.id } });
    await admin.user.delete({ where: { id: user.id } });

    const redemption = await admin.trialRedemption.findUnique({
      where: { subjectHash: trialSubjectHash(email) },
    });
    expect(redemption).toBeTruthy();
    expect(redemption?.redeemedByUserId).toBeNull();
  });

  it('P101-TRIAL-012 — account RECREATION with the same address gets no fresh trial', async () => {
    // The headline scenario: sign up, redeem, delete everything, sign up
    // again with the same address.
    const email = uniqueTestEmail('t012');
    const firstToken = await signUp(email);
    const firstOrg = await createOrganization(firstToken, `T012 a ${Date.now()}`);
    expect(await hasUsableTrial(firstOrg.body.id)).toBe(true);

    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    // The application has no account-deletion endpoint, and the database
    // additionally refuses to drop a user while audit entries reference
    // them. Clearing those first makes this the most aggressive wipe the
    // schema physically permits — a stronger test than any real deletion
    // flow could be.
    await admin.auditLogEntry.deleteMany({ where: { actorUserId: user.id } });
    await admin.organization.delete({ where: { id: firstOrg.body.id } });
    await admin.user.delete({ where: { id: user.id } });

    // Same address, brand-new account, brand-new user id.
    const secondToken = await signUp(email);
    const secondOrg = await createOrganization(secondToken, `T012 b ${Date.now()}`);
    expect(await hasUsableTrial(secondOrg.body.id)).toBe(false);
  });

  it('P101-TRIAL-013 — changing device, browser, IP and network does not restore eligibility', async () => {
    // Every client-controlled signal an abuser can trivially change, all
    // changed at once. None of them is part of the eligibility decision,
    // so none of them helps.
    const token = await signUp(uniqueTestEmail('t013'));
    const stamp = Date.now();

    const first = await createOrganization(token, `T013 a ${stamp}`);
    expect(await hasUsableTrial(first.body.id)).toBe(true);

    const evasive = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${token}`)
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1')
      .set('X-Forwarded-For', '203.0.113.77')
      .set('CF-Connecting-IP', '198.51.100.42')
      .set('Cookie', '')
      .send({ name: `T013 evasive ${stamp}` })
      .expect(201);

    // Explicitly ask for a trial from the "new device", on a new IP, with
    // cookies cleared. The refusal must come anyway.
    const attempt = await request(app.getHttpServer())
      .post(`/organizations/${evasive.body.id}/subscription/trial`)
      .set('Authorization', `Bearer ${token}`)
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1')
      .set('X-Forwarded-For', '203.0.113.77')
      .set('CF-Connecting-IP', '198.51.100.42')
      .set('Cookie', '')
      .send({ confirm: true })
      .expect(200);

    expect(attempt.body.started).toBe(false);
    expect(await hasUsableTrial(evasive.body.id)).toBe(false);
  });

  it('P101-TRIAL-014 — direct API calls cannot bypass eligibility', async () => {
    // There is no client-supplied trial field to forge, and sending one
    // must not be silently honoured. `forbidNonWhitelisted` rejects the
    // unknown property outright, which is the strongest possible outcome.
    const token = await signUp(uniqueTestEmail('t014'));
    const stamp = Date.now();

    await createOrganization(token, `T014 a ${stamp}`);

    const forged = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: `T014 forged ${stamp}`,
        trialEndsAt: new Date(Date.now() + 999 * 86_400_000).toISOString(),
        status: 'trialing',
        isTrialEligible: true,
      });

    // Either the payload is rejected outright, or the extra fields are
    // ignored — never honoured.
    if (forged.status === 201) {
      expect(await hasUsableTrial(forged.body.id)).toBe(false);
    } else {
      expect(forged.status).toBe(400);
    }
  });

  it('P101-TRIAL-015 — the eligibility decision ignores IP entirely (shared-NAT protection)', async () => {
    // Two genuinely different customers behind one corporate NAT: same
    // source address, same user agent, different mailboxes. Both must get
    // their trial. This is the explicit false-positive requirement.
    const stamp = Date.now();
    const sharedIp = '203.0.113.200';
    const sharedAgent = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36';

    const colleagueA = await signUp(uniqueTestEmail('t015-a'));
    const colleagueB = await signUp(uniqueTestEmail('t015-b'));

    const orgA = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${colleagueA}`)
      .set('CF-Connecting-IP', sharedIp)
      .set('User-Agent', sharedAgent)
      .send({ name: `T015 a ${stamp}` })
      .expect(201);

    const orgB = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${colleagueB}`)
      .set('CF-Connecting-IP', sharedIp)
      .set('User-Agent', sharedAgent)
      .send({ name: `T015 b ${stamp}` })
      .expect(201);

    // Both colleagues explicitly redeem, from the same source address and
    // the same user agent. Neither may be refused because of the other.
    for (const [token, orgId] of [
      [colleagueA, orgA.body.id],
      [colleagueB, orgB.body.id],
    ] as const) {
      await request(app.getHttpServer())
        .post(`/organizations/${orgId}/subscription/trial`)
        .set('Authorization', `Bearer ${token}`)
        .set('CF-Connecting-IP', sharedIp)
        .set('User-Agent', sharedAgent)
        .send({ confirm: true })
        .expect(200);
    }

    expect(await hasUsableTrial(orgA.body.id)).toBe(true);
    expect(await hasUsableTrial(orgB.body.id)).toBe(true);
  });

  it('P101-TRIAL-016 — the redemption record stores no email address in the clear', async () => {
    const email = uniqueTestEmail('t016');
    const token = await signUp(email);
    await createOrganization(token, `T016 ${Date.now()}`);

    const row = await admin.trialRedemption.findUniqueOrThrow({
      where: { subjectHash: trialSubjectHash(email) },
    });

    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(email);
    expect(serialised).not.toContain(email.split('@')[0]);
    // A hex digest, not a reversible encoding of the address.
    expect(row.subjectHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('P101-TRIAL-017 — the application role cannot DELETE or UPDATE a redemption', async () => {
    // The database itself, not application discipline, is what keeps this
    // history intact. `atlas_app` had UPDATE/DELETE revoked by the
    // migration, so even a bug or a compromised app role cannot erase a
    // consumed trial.
    const grants = await admin.$queryRawUnsafe<{ privilege_type: string }[]>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = 'atlas_app' AND table_name = 'trial_redemptions'`,
    );
    const held = grants.map((g) => g.privilege_type);

    expect(held).toContain('SELECT');
    expect(held).toContain('INSERT');
    expect(held).not.toContain('DELETE');
    expect(held).not.toContain('UPDATE');
  });

  it('P101-TRIAL-018 — an expired trial cannot be re-redeemed by making another organization', async () => {
    const email = uniqueTestEmail('t018');
    const token = await signUp(email);
    const first = await createOrganization(token, `T018 a ${Date.now()}`);

    // Force the trial to have run out, exactly as the expiry sweep would.
    await admin.tenantSubscription.update({
      where: { organizationId: first.body.id },
      data: { trialEndsAt: new Date(Date.now() - 86_400_000), status: 'expired' },
    });

    const second = await createOrganization(token, `T018 b ${Date.now()}`);
    expect(await hasUsableTrial(second.body.id)).toBe(false);
  });
});
