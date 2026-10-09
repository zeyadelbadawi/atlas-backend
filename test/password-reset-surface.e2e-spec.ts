/**
 * Production QA Issue 5 — a password reset requested on an academy website
 * must return its reader to THAT academy, not to Atlas Management.
 *
 *  - RSF-01 — a learner of academy A, asking on A's host, gets A's email:
 *    A's name, a link to `https://<A host>/reset-password?token=…`, and the
 *    "your password was reset" notice confirmed there links back to A's
 *    own `/forgot-password`.
 *  - RSF-02 — staff of academy A, asking on A's host, gets the same.
 *  - RSF-03 — the same learner, asking on the management host, gets the
 *    management email exactly as before.
 *  - RSF-04 — an account that does NOT belong to A, asking on A's host,
 *    gets the management email; the request is answered exactly like a
 *    member's and an unknown address's; resetting gives it nothing in A.
 *  - RSF-05 — the academy cannot be chosen by the caller: a body field
 *    naming another academy is refused by validation, so only the host the
 *    request reached counts.
 *
 * Every email is pulled out of the stub provider after the REAL queue,
 * worker and dispatcher ran — the same path production takes.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail, waitFor } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { StubEmailProvider } from '../src/identity/services/stub-email.provider';
import type { EmailSendInput } from '../src/identity/services/email-provider.interface';

jest.setTimeout(120000);

const PASSWORD = 'correct-horse-battery-rsf';
const NEW_PASSWORD = 'donkey-staple-battery-rsf-2';
const BASE = 'resetsurface.test';
const ENV_KEYS = ['PLATFORM_BASE_DOMAIN'] as const;

describe('Password reset surface (e2e) — RSF-01..05', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let stubEmail: StubEmailProvider;
  let flush: () => Promise<void>;

  beforeAll(async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.PLATFORM_BASE_DOMAIN = BASE;
    const testApp = await createTestApp();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    app = testApp.app;
    stubEmail = testApp.stubEmailProvider;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const http = () => request(app.getHttpServer());

  async function account(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .set('Host', BASE)
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  /** A serving academy reachable at its own connected custom domain. */
  async function academy(label: string) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const a = await seedAcademy(admin, org.id, `${label}-academy`);
    const name = `RSF Academy ${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await admin.academy.update({ where: { id: a.id }, data: { status: 'active', name } });
    await seedAcademyMember(admin, a.id, owner.userId, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.custom.test`;
    await admin.domainConnection.create({
      data: {
        academyId: a.id,
        hostname: host,
        status: 'connected',
        httpsReachable: true,
      },
    });
    // Its Atlas subdomain — where credential links land (ATO review F4):
    // the custom domain's DNS belongs to the tenant.
    const subdomain = `${label}-${Math.random().toString(36).slice(2, 9)}`;
    const atlasHost = `${subdomain}.${BASE}`;
    await admin.subdomainAllocation.create({
      data: { academyId: a.id, subdomain, status: 'assigned', fullHost: atlasHost },
    });
    return { id: a.id, host, atlasHost, name, owner };
  }

  function requestReset(email: string, host: string) {
    return http().post('/auth/password-reset/request').set('Host', host).send({ email });
  }

  /** Waits for the reset email the real worker + dispatcher send `email`. */
  async function resetEmail(
    email: string,
  ): Promise<{ token: string; send: EmailSendInput }> {
    const token = await waitFor(() => stubEmail.peekLastPasswordResetToken(email), {
      timeoutMs: 20000,
    });
    const send = [...stubEmail.recordedSends()]
      .reverse()
      .find(
        (input) =>
          input.to.toLowerCase() === email.toLowerCase() &&
          (input.html ?? input.text).includes(token),
      );
    if (!send) throw new Error(`No reset email for ${email}`);
    return { token, send };
  }

  async function confirm(token: string, host: string) {
    await http()
      .post('/auth/password-reset/confirm')
      .set('Host', host)
      .send({ token, newPassword: NEW_PASSWORD })
      .expect(200);
  }

  async function outboxRow(userId: string, key: string) {
    return waitForRow(() =>
      admin.communicationOutbox.findFirst({
        where: { recipientUserId: userId, key },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async function waitForRow<T>(read: () => Promise<T | null>): Promise<T> {
    const deadline = Date.now() + 20000;
    for (;;) {
      const row = await read();
      if (row) return row;
      if (Date.now() > deadline) throw new Error('Row never appeared');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("RSF-01 — a learner of academy A, asking on A's host, is sent back to A", async () => {
    const a = await academy('rsf01');
    const learner = await account('rsf01-learner');
    await seedAcademyStudent(admin, a.id, learner.userId);

    const response = await requestReset(learner.email, a.host).expect(200);
    expect(response.body).toEqual({});

    const { token, send } = await resetEmail(learner.email);
    const body = `${send.html ?? ''}\n${send.text}`;
    // The request was made on the custom domain; the token-carrying link
    // goes to the academy's Atlas subdomain (ATO review F4).
    expect(body).toContain(`https://${a.atlasHost}/reset-password?token=${token}`);
    expect(body).not.toContain(`https://${a.host}/reset-password`);
    expect(body).not.toContain('/auth/reset-password');
    expect(body).toContain(a.name);

    const row = await outboxRow(learner.userId, 'auth.password.reset');
    expect(row.academyId).toBe(a.id);
    // Never tenant-visible: the row carried a live link.
    expect(row.organizationId).toBeNull();

    // The token is the same single-use credential either surface uses.
    await confirm(token, a.host);
    const notice = await outboxRow(learner.userId, 'auth.password.reset_confirmed');
    expect(notice.academyId).toBe(a.id);
    expect(notice.organizationId).toBeNull();
    const confirmedEmail = await waitFor(
      () => {
        const sent = stubEmail.peekLastTransactionalEmail(learner.email);
        return sent && sent.html?.includes(`https://${a.host}/forgot-password`)
          ? sent
          : undefined;
      },
      { timeoutMs: 20000 },
    );
    expect(confirmedEmail.html).not.toContain('/auth/forgot-password');

    // A reset grants nothing: the learner is exactly the learner they were.
    expect(await admin.academyStudent.count({ where: { userId: learner.userId } })).toBe(
      1,
    );
  });

  it("RSF-02 — staff of academy A, asking on A's host, is sent back to A", async () => {
    const a = await academy('rsf02');
    await requestReset(a.owner.email, a.host).expect(200);
    const { token, send } = await resetEmail(a.owner.email);
    expect(`${send.html ?? ''}\n${send.text}`).toContain(
      `https://${a.atlasHost}/reset-password?token=${token}`,
    );
  });

  it('RSF-03 — the same learner, asking on the management host, gets the management email', async () => {
    const a = await academy('rsf03');
    const learner = await account('rsf03-learner');
    await seedAcademyStudent(admin, a.id, learner.userId);

    await requestReset(learner.email, BASE).expect(200);
    const { token, send } = await resetEmail(learner.email);
    const body = `${send.html ?? ''}\n${send.text}`;
    expect(body).toContain(`/auth/reset-password?token=${token}`);
    expect(body).not.toContain(a.host);

    const row = await outboxRow(learner.userId, 'auth.password.reset');
    expect(row.academyId).toBeNull();
  });

  it("RSF-04 — an account outside A, asking on A's host, learns nothing and gains nothing", async () => {
    const a = await academy('rsf04-a');
    const b = await academy('rsf04-b');
    const outsider = await account('rsf04-outsider');
    await seedAcademyStudent(admin, b.id, outsider.userId);
    const member = await account('rsf04-member');
    await seedAcademyStudent(admin, a.id, member.userId);

    // Member, outsider and an address with no account are answered alike.
    const answers = await Promise.all(
      [member.email, outsider.email, uniqueTestEmail('rsf04-nobody')].map((email) =>
        requestReset(email, a.host),
      ),
    );
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual({});
    }

    // The outsider's email is the management one, with no trace of A…
    const { token, send } = await resetEmail(outsider.email);
    const body = `${send.html ?? ''}\n${send.text}`;
    expect(body).toContain(`/auth/reset-password?token=${token}`);
    expect(body).not.toContain(a.host);
    expect(body).not.toContain(a.name);
    const row = await outboxRow(outsider.userId, 'auth.password.reset');
    expect(row.academyId).toBeNull();

    // …and completing it on A's host does not make them part of A.
    await confirm(token, a.host);
    const notice = await outboxRow(outsider.userId, 'auth.password.reset_confirmed');
    expect(notice.academyId).toBeNull();
    expect(
      await admin.academyStudent.count({
        where: { userId: outsider.userId, academyId: a.id },
      }),
    ).toBe(0);
    expect(
      await admin.academyMember.count({
        where: { userId: outsider.userId, academyId: a.id },
      }),
    ).toBe(0);
  });

  it('RSF-05 — the caller cannot pick the academy: only the host counts', async () => {
    const a = await academy('rsf05');
    const learner = await account('rsf05-learner');
    await http()
      .post('/auth/password-reset/request')
      .set('Host', BASE)
      .send({ email: learner.email, academyId: a.id })
      .expect(400);
  });
});
