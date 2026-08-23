/**
 * `POST /auth/register` e2e — against real Postgres (master plan §21 P1
 * requirement #19, this file's checklist item B).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';

describe('POST /auth/register (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
  });

  afterAll(async () => {
    await app.close();
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
});
