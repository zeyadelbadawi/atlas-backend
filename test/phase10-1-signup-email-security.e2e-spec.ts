/**
 * Phase 10.1 — signup email security suite (P101-MAIL-001..012).
 *
 * WHY THIS MATTERS BEYOND HYGIENE. Free-Trial eligibility is keyed on the
 * canonical email address. If minting a fresh mailbox is free, the trial
 * protection collapses: an abuser points at a throwaway inbox provider
 * and generates unlimited new "subjects". Disposable blocking,
 * deliverability and verification are therefore one mechanism with the
 * trial work, not three separate features.
 *
 * WHAT IS ASSERTED AND WHAT IS NOT. These tests assert that the SERVER
 * enforces the policy — every case calls the API directly, because
 * frontend validation is not a security control. They do not assert that
 * a given domain will be disposable forever; the dataset is a maintained
 * dependency, so the tests pin behaviour on domains whose status is
 * stable and well known.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';
import { StubEmailProvider } from '../src/identity/services/stub-email.provider';

const PASSWORD = 'correct-horse-battery';

describe('Phase 10.1 signup email security (e2e) — P101-MAIL-001..012', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let stubEmail: StubEmailProvider;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    stubEmail = app.get(StubEmailProvider);
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  function register(email: string) {
    return request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Mail Tester', email, password: PASSWORD });
  }

  it('P101-MAIL-001 — a normal consumer address is accepted', async () => {
    await register(`p101mail001-${Date.now()}@gmail.com`).expect(201);
  });

  it('P101-MAIL-002 — a custom business domain is accepted', async () => {
    // The explicit false-positive guard: "not a well-known consumer
    // provider" must never read as suspicious. A real company domain
    // with valid MX records passes exactly like Gmail.
    await register(`p101mail002-${Date.now()}@anthropic.com`).expect(201);
  });

  it('P101-MAIL-003 — an educational/organisation domain is accepted', async () => {
    await register(`p101mail003-${Date.now()}@mit.edu`).expect(201);
  });

  it('P101-MAIL-004 — a known disposable provider is REJECTED', async () => {
    const response = await register(`p101mail004-${Date.now()}@mailinator.com`);
    expect(response.status).toBe(400);
    expect(response.body.error.messageKey).toBe('errors.auth.emailNotAcceptable');
  });

  it('P101-MAIL-005 — several distinct throwaway providers are all rejected', async () => {
    // One provider passing would be enough to restore unlimited trial
    // subjects, so breadth matters more than any single domain.
    for (const domain of ['guerrillamail.com', 'yopmail.com', '10minutemail.com']) {
      await flushRateLimitKeys();
      const response = await register(`p101mail005-${Date.now()}@${domain}`);
      expect(response.status).toBe(400);
    }
  });

  // NOTE ON DELIVERABILITY. The DNS half of the policy is deliberately
  // OFF in `test` (`IdentityConfig.emailDeliverabilityCheckEnabled`):
  // this suite — and every pre-existing e2e suite — registers accounts at
  // `@atlas.test`, a reserved TLD that by definition has no DNS, and
  // making the whole test run depend on live DNS would be slow, flaky,
  // and broken on an offline CI runner. That logic is covered
  // deterministically by `email-risk.service.spec.ts` with mocked DNS
  // instead. The disposable-domain half is local and always active, in
  // every environment, which is what the tests above exercise.

  it('P101-MAIL-007 — every rejection uses one identical generic message', async () => {
    // Telling an abuser whether the domain was on a list or simply lacked
    // MX records tells them exactly how to adapt, so all rejections
    // collapse to a single message key.
    const first = await register(`p101mail007a-${Date.now()}@mailinator.com`);
    await flushRateLimitKeys();
    const second = await register(`p101mail007b-${Date.now()}@guerrillamail.com`);

    expect(first.body.error.messageKey).toBe('errors.auth.emailNotAcceptable');
    expect(second.body.error.messageKey).toBe(first.body.error.messageKey);
    // And it never names the domain, the list, or the mechanism.
    const serialised = JSON.stringify(first.body);
    expect(serialised).not.toContain('mailinator');
    expect(serialised.toLowerCase()).not.toContain('disposable');
    expect(serialised.toLowerCase()).not.toContain('mx');
  });

  it('P101-MAIL-008 — calling the API directly cannot bypass the policy', async () => {
    // There is no frontend involved in any test in this file; this one
    // states the claim explicitly, including an attempt to smuggle an
    // already-verified flag past the DTO.
    const forged = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Direct Caller',
        email: `p101mail008-${Date.now()}@mailinator.com`,
        password: PASSWORD,
        emailVerifiedAt: new Date().toISOString(),
        skipEmailCheck: true,
      });

    expect([400]).toContain(forged.status);
  });

  it('P101-MAIL-009 — a new account starts UNVERIFIED and receives a verification token', async () => {
    const email = uniqueTestEmail('p101mail009');
    await register(email).expect(201);

    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull();

    // A real token was issued and sent.
    const token = stubEmail.peekLastEmailVerificationToken(email);
    expect(token).toBeTruthy();

    const stored = await admin.emailVerificationToken.findFirst({
      where: { userId: user.id },
    });
    expect(stored).toBeTruthy();
    // Stored hashed, never in the clear.
    expect(stored?.tokenHash).not.toBe(token);
    expect(stored?.usedAt).toBeNull();
  });

  it('P101-MAIL-010 — a valid token verifies the address exactly once', async () => {
    const email = uniqueTestEmail('p101mail010');
    await register(email).expect(201);
    const token = stubEmail.peekLastEmailVerificationToken(email)!;

    await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ token })
      .expect(200);

    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);

    // REPLAY: the same link a second time must fail.
    const replay = await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ token });
    expect(replay.status).toBe(400);
    expect(replay.body.error.messageKey).toBe('errors.auth.invalidVerificationToken');
  });

  it('P101-MAIL-011 — an expired token is refused', async () => {
    const email = uniqueTestEmail('p101mail011');
    await register(email).expect(201);
    const token = stubEmail.peekLastEmailVerificationToken(email)!;

    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    await admin.emailVerificationToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ token })
      .expect(400);

    const after = await admin.user.findUniqueOrThrow({ where: { email } });
    expect(after.emailVerifiedAt).toBeNull();
  });

  it('P101-MAIL-012 — an unknown token is refused with the same generic error', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/verify-email')
      .send({ token: 'a'.repeat(64) });

    expect(response.status).toBe(400);
    expect(response.body.error.messageKey).toBe('errors.auth.invalidVerificationToken');
    // No token material echoed back.
    expect(JSON.stringify(response.body)).not.toContain('a'.repeat(64));
  });
});
