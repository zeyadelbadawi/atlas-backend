/**
 * `POST /auth/register` e2e — against real Postgres (master plan §21 P1
 * requirement #19, this file's checklist item B).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import {
  createAdminPrisma,
  seedAcademy,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

describe('POST /auth/register (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
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

    // No tokens, no user object — matches `authenticationService.register(): Promise<void>`.
    expect(response.body).toEqual({});

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user?.status).toBe('active');
    expect(user?.passwordHash).not.toBe('correct-horse-battery');
    expect(user?.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('rejects a duplicate email with a normalized conflict error', async () => {
    const email = uniqueTestEmail('register-dup');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'First', email, password: 'correct-horse-battery' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Second', email, password: 'another-password-here' })
      .expect(409);

    expect(response.body.error.kind).toBe('conflict');
    expect(response.body.error.messageKey).toBe('errors.auth.emailAlreadyRegistered');
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
      .expect(409);
  });

  /* ------- Phase 1 (Extended Scope, Decision 11, dependency D) ------- */

  async function seedRealAcademy(label: string) {
    const owner = await admin.user.create({
      data: { email: uniqueTestEmail(`${label}-owner`), passwordHash: 'x', name: label },
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
