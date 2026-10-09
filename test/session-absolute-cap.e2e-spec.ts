/**
 * ATO review F10 — a session has an absolute lifetime from sign-in
 * (management 30 days, academy 90 by default), however often it refreshes.
 *
 *   SAC-01  sign-in records when the session started; the token expires no
 *           later than start + cap
 *   SAC-02  a refresh near the cap works, carries the start forward, and the
 *           new token's expiry is clamped to start + cap
 *   SAC-03  a refresh past the cap is a generic 401, ends the whole session
 *           family, mints nothing, and is not treated as token reuse
 *   SAC-04  a row from before the column existed (null start) falls back to
 *           its own creation time — never more lenient than the truth
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';

import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { sessionTokenFrom } from './utils/session-cookie';
import { hashOpaqueToken } from '../src/identity/utils/opaque-token.util';

jest.setTimeout(120000);

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'correct-horse-battery-sac';

describe('Absolute session lifetime (e2e) — ATO F10', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());

  async function signedIn(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: 'SAC Tester', email, password: PASSWORD })
      .expect(201);
    const response = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    const refreshToken = sessionTokenFrom(response) as string;
    const row = await admin.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashOpaqueToken(refreshToken) },
    });
    return { refreshToken, row };
  }

  /** Moves the session's start back `days` days (as if signed in then). */
  async function ageSession(sessionId: string, days: number, nullStart = false) {
    const startedAt = new Date(Date.now() - days * DAY);
    await admin.refreshToken.updateMany({
      where: { sessionId },
      data: { sessionStartedAt: nullStart ? null : startedAt, createdAt: startedAt },
    });
    return startedAt;
  }

  it('SAC-01 — sign-in records the start and caps the first expiry', async () => {
    const before = Date.now();
    const { row } = await signedIn('sac-01');
    expect(row.sessionStartedAt).not.toBeNull();
    expect(row.sessionStartedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(
      row.sessionStartedAt!.getTime() + 30 * DAY + 1000,
    );
  });

  it('SAC-02 — a refresh near the cap works and is clamped to start + cap', async () => {
    const { refreshToken, row } = await signedIn('sac-02');
    const startedAt = await ageSession(row.sessionId, 29);

    const response = await http()
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    const next = await admin.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashOpaqueToken(sessionTokenFrom(response) as string) },
    });
    expect(next.sessionId).toBe(row.sessionId);
    expect(next.sessionStartedAt?.getTime()).toBe(startedAt.getTime());
    expect(next.expiresAt.getTime()).toBe(startedAt.getTime() + 30 * DAY);
  });

  it('SAC-03 — a refresh past the cap ends the session, mints nothing, and is not reuse', async () => {
    const { refreshToken, row } = await signedIn('sac-03');
    await ageSession(row.sessionId, 31);

    const response = await http()
      .post('/auth/refresh')
      .send({ refreshToken })
      .expect(401);
    expect(response.body.error.messageKey).toBe('errors.auth.invalidRefreshToken');

    const rows = await admin.refreshToken.findMany({
      where: { sessionId: row.sessionId },
    });
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    const reuseAudits = await admin.auditLogEntry.count({
      where: {
        actorUserId: row.userId,
        action: 'auth.sessions.revoked',
      },
    });
    expect(reuseAudits).toBe(0);

    // The spent token stays dead.
    await http().post('/auth/refresh').send({ refreshToken }).expect(401);
  });

  it("SAC-04 — a null start falls back to the row's own creation time", async () => {
    const { refreshToken, row } = await signedIn('sac-04');
    await ageSession(row.sessionId, 31, true);
    await http().post('/auth/refresh').send({ refreshToken }).expect(401);
    const fresh = await signedIn('sac-04b');
    await ageSession(fresh.row.sessionId, 5, true);
    const ok = await http()
      .post('/auth/refresh')
      .send({ refreshToken: fresh.refreshToken })
      .expect(200);
    const next = await admin.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashOpaqueToken(sessionTokenFrom(ok) as string) },
    });
    expect(next.sessionStartedAt).not.toBeNull();
    expect(next.expiresAt.getTime()).toBeLessThanOrEqual(
      next.sessionStartedAt!.getTime() + 30 * DAY,
    );
  });
});
