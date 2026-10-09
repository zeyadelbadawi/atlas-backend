/**
 * ATO review F9 — a password-reset REQUEST does the same work for every
 * address; the account lookup and the token happen in the worker.
 *
 *   PRU-01  the request enqueues the same `{ kind: 'request', email }` job
 *           for an address with an account and one without, carries no
 *           token, and creates no token row itself
 *   PRU-02  the worker, given a request job for a real account, mints the
 *           token and writes the reset email; for an unknown address it
 *           writes nothing
 *   PRU-03  a legacy job (queued before this change, token included) is
 *           still delivered
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';

import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { PasswordResetEmailProducer } from '../src/identity/queue/password-reset-email.producer';
import { PasswordResetEmailProcessor } from '../src/identity/queue/password-reset-email.processor';
import type {
  PasswordResetEmailJobPayload,
  PasswordResetRequestJobPayload,
} from '../src/identity/queue/password-reset-email.types';

jest.setTimeout(120000);

class RecordingProducer {
  readonly jobs: PasswordResetRequestJobPayload[] = [];
  async enqueue(payload: PasswordResetRequestJobPayload): Promise<void> {
    this.jobs.push(payload);
  }
}

describe('Password reset request uniformity (e2e) — ATO F9', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let producer: RecordingProducer;
  let processor: PasswordResetEmailProcessor;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    producer = new RecordingProducer();
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder.overrideProvider(PasswordResetEmailProducer).useValue(producer),
    });
    app = testApp.app;
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    processor = app.get(PasswordResetEmailProcessor);
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
    producer.jobs.length = 0;
  });

  const http = () => request(app.getHttpServer());

  async function register(label: string): Promise<{ email: string; userId: string }> {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: 'PRU Tester', email, password: 'correct-horse-battery-pru' })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  const resetRows = (userId: string) =>
    admin.passwordResetToken.count({ where: { userId } });
  const resetEmails = (userId: string) =>
    admin.communicationOutbox.count({
      where: { recipientUserId: userId, key: 'auth.password.reset' },
    });

  function asJob(data: PasswordResetEmailJobPayload): Job<PasswordResetEmailJobPayload> {
    return { id: 'pru', data } as Job<PasswordResetEmailJobPayload>;
  }

  it('PRU-01 — the request enqueues the same token-free job for any address and mints nothing', async () => {
    const known = await register('pru-01');
    const unknown = uniqueTestEmail('pru-01-nobody');

    const a = await http()
      .post('/auth/password-reset/request')
      .send({ email: known.email });
    const b = await http().post('/auth/password-reset/request').send({ email: unknown });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);

    expect(producer.jobs).toEqual([
      { kind: 'request', email: known.email },
      { kind: 'request', email: unknown },
    ]);
    expect(await resetRows(known.userId)).toBe(0);
  });

  it('PRU-02 — the worker mints the token for a real account and does nothing for an unknown one', async () => {
    const known = await register('pru-02');
    await processor.process(asJob({ kind: 'request', email: known.email }));
    expect(await resetRows(known.userId)).toBe(1);
    expect(await resetEmails(known.userId)).toBe(1);

    const before = await admin.passwordResetToken.count();
    await processor.process(
      asJob({ kind: 'request', email: uniqueTestEmail('pru-02-nobody') }),
    );
    expect(await admin.passwordResetToken.count()).toBe(before);
  });

  it('PRU-03 — a legacy job queued before the change is still delivered', async () => {
    const known = await register('pru-03');
    await processor.process(
      asJob({
        userId: known.userId,
        email: known.email,
        rawToken: 'legacy-token-pru-03-0000000000000000',
        expiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
      }),
    );
    expect(await resetEmails(known.userId)).toBe(1);
  });
});
