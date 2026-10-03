/**
 * `POST /auth/register` e2e — against real Postgres (master plan §21 P1
 * requirement #19, this file's checklist item B).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

describe('POST /auth/register (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    // Fixture and verification reads go through the owner connection: the
    // app's own client is RLS-bound and sees identity rows only inside a
    // user context (authentication audit, Decision 2).
    prisma = createAdminPrisma();
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.$disconnect();
    await app.close();
  });

  // Same rationale as every other e2e spec file (see `test/utils/test-app.ts`):
  // without this, this file's own 7 real `/auth/register` calls (Phase P18
  // added a dedicated rate limit to this endpoint) would accumulate against
  // each other and any earlier spec file run in the same process/IP.
  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  it('registers a new account and does not establish a session', async () => {
    const email = uniqueTestEmail('register-ok');

    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Ada Lovelace', email, password: 'correct-horse-battery' })
      .expect(201);

    // No tokens, no user object — only which kind of account the email now
    // names (Launch Stabilization A4: `new` here; `existing` when an
    // existing account joined an academy through its sign-up).
    expect(response.body).toEqual({ account: 'new' });

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user?.status).toBe('active');
    // The credential lives in its own table, as an Argon2id hash — never on
    // the directory row and never the plaintext.
    const credential = await prisma.userCredential.findUniqueOrThrow({
      where: { userId: user!.id },
    });
    expect(credential.passwordHash).not.toBe('correct-horse-battery');
    expect(credential.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(Object.keys(user!)).not.toContain('passwordHash');
  });

  it('answers a duplicate email exactly like a new one and creates nothing (audit Decision 3)', async () => {
    const email = uniqueTestEmail('register-dup');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'First', email, password: 'correct-horse-battery' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Second', email, password: 'another-password-here' })
      .expect(201);

    expect(response.body).toEqual({ account: 'new' });
    // Still ONE account, still the first one's name and password.
    const users = await admin.user.findMany({ where: { email } });
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe('First');
  });

  it('rejects an invalid payload (short password) as a validation error', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Short Pw',
        email: uniqueTestEmail('register-short'),
        password: 'short',
      })
      .expect(400);

    expect(response.body.error.kind).toBe('validation');
  });

  it('rejects an invalid payload (malformed email)', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Bad Email',
        email: 'not-an-email',
        password: 'correct-horse-battery',
      })
      .expect(400);
  });

  it('normalizes email case — registering with different casing collides', async () => {
    const base = uniqueTestEmail('register-case');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Lower', email: base, password: 'correct-horse-battery' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Upper',
        email: base.toUpperCase(),
        password: 'correct-horse-battery',
      })
      // Audit Decision 3: the collision answers like a new address…
      .expect(201);
    // …and still creates nothing: one account, the lower-case one.
    const users = await admin.user.findMany({
      where: { email: { equals: base, mode: 'insensitive' } },
    });
    expect(users.map((u) => u.name)).toEqual(['Lower']);
  });

  /* ------- Phase 1 (Extended Scope, Decision 11, dependency D) ------- */

  async function seedRealAcademy(label: string) {
    const owner = await admin.user.create({
      data: { email: uniqueTestEmail(`${label}-owner`), name: label },
    });
    const org = await seedOrganizationWithOwner(admin, owner.id, `${label}-org`);
    return seedAcademy(admin, org.id, `${label}-academy`);
  }

  it('registering with a real academyId (the public Academy website Sign Up flow) creates a real, Academy-scoped membership', async () => {
    const academy = await seedRealAcademy('register-academy-scoped');
    const email = uniqueTestEmail('register-with-academy');

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'New Student',
        email,
        password: 'correct-horse-battery',
        academyId: academy.id,
      })
      .expect(201);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();

    const membership = await admin.academyStudent.findUnique({
      where: { academyId_userId: { academyId: academy.id, userId: user!.id } },
    });
    expect(membership).not.toBeNull();
    expect(membership?.status).toBe('active');
  });

  it('registering through two different academies produces two independent memberships, one per academy', async () => {
    const academyA = await seedRealAcademy('register-independent-a');
    const academyB = await seedRealAcademy('register-independent-b');
    const emailA = uniqueTestEmail('register-independent-student-a');
    const emailB = uniqueTestEmail('register-independent-student-b');

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Student A',
        email: emailA,
        password: 'correct-horse-battery',
        academyId: academyA.id,
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Student B',
        email: emailB,
        password: 'correct-horse-battery',
        academyId: academyB.id,
      })
      .expect(201);

    const userA = await prisma.user.findUniqueOrThrow({ where: { email: emailA } });
    const userB = await prisma.user.findUniqueOrThrow({ where: { email: emailB } });

    const membershipAInB = await admin.academyStudent.findUnique({
      where: { academyId_userId: { academyId: academyB.id, userId: userA.id } },
    });
    const membershipBInA = await admin.academyStudent.findUnique({
      where: { academyId_userId: { academyId: academyA.id, userId: userB.id } },
    });
    expect(membershipAInB).toBeNull();
    expect(membershipBInA).toBeNull();

    const membershipA = await admin.academyStudent.findUnique({
      where: { academyId_userId: { academyId: academyA.id, userId: userA.id } },
    });
    const membershipB = await admin.academyStudent.findUnique({
      where: { academyId_userId: { academyId: academyB.id, userId: userB.id } },
    });
    expect(membershipA).not.toBeNull();
    expect(membershipB).not.toBeNull();
  });

  it('an existing account joining an academy is audited under that academy and its organization (Task 3)', async () => {
    const academy = await seedRealAcademy('register-existing-join');
    const email = uniqueTestEmail('register-existing-join-student');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Existing Learner', email, password: 'correct-horse-battery' })
      .expect(201);

    const joined = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Existing Learner',
        email,
        password: 'correct-horse-battery',
        academyId: academy.id,
      })
      .expect(201);
    expect(joined.body).toMatchObject({ account: 'existing' });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const entry = await admin.auditLogEntry.findFirstOrThrow({
      where: {
        action: 'academy.student.joined',
        targetId: user.id,
        academyId: academy.id,
      },
    });
    // Without the organization the Academy's activity log never shows it.
    expect(entry.organizationId).toBe(academy.organizationId);
  });

  it('rejects registration against an unknown academyId — never silently falls back to an academy-less account', async () => {
    const email = uniqueTestEmail('register-unknown-academy');

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Ghost Student',
        email,
        password: 'correct-horse-battery',
        academyId: 'not-a-real-academy-id',
      })
      .expect(404);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).toBeNull();
  });

  it('registering with no academyId still works exactly as before (the self-service Organization-Owner onboarding journey, Decision 5) and creates no academy membership', async () => {
    const email = uniqueTestEmail('register-no-academy');

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Future Owner', email, password: 'correct-horse-battery' })
      .expect(201);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const memberships = await admin.academyStudent.findMany({
      where: { userId: user.id },
    });
    expect(memberships).toEqual([]);
  });
});
