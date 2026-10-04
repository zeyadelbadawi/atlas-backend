/**
 * Authentication audit, Decision 3 — registration never reveals whether an
 * address already has an account ("If an account exists, we'll help you
 * continue"). Real PostgreSQL (RLS) and Redis.
 *
 *   ENUM-01  platform sign-up: an existing address gets the new-address answer,
 *            nothing is created, the owner is emailed — once an hour
 *   ENUM-02  organization sign-up: the same, and rule failures (organization
 *            name) are identical for both
 *   ENUM-03  academy (open): wrong password → the new-address answer, not
 *            joined, owner emailed; right password → joined as before
 *   ENUM-04  academy (invite-only): a bad code is inviteInvalid for BOTH; a
 *            valid code with an unproven existing address is NOT spent
 *   ENUM-05  invited and Google-only accounts: the same generic answer
 *   ENUM-06  the per-address budget applies to every address alike
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IdentityConfig } from '../src/config/configuration';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../src/identity/utils/opaque-token.util';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { uniqueName } from './utils/unique-name';

jest.setTimeout(180000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-enum';

describe('Registration does not enumerate accounts (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler),
    });
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    // Organization sign-up on, as in production (the live config object).
    (
      app.get(ConfigService).getOrThrow<IdentityConfig>('identity') as {
        signupOrganizationMode: string;
      }
    ).signupOrganizationMode = 'on';
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const http = () => request(app.getHttpServer());
  const register = (body: Record<string, unknown>, host?: string) => {
    const req = http().post('/auth/register');
    return (host ? req.set('Host', host) : req).send(body);
  };

  async function existingAccount(label: string) {
    const email = uniqueTestEmail(label);
    await register({ name: label, email, password: PASSWORD }).expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    return { email, userId: user.id };
  }

  const notices = (userId: string) =>
    admin.communicationOutbox.count({
      where: { recipientUserId: userId, key: 'auth.account.signup_attempt' },
    });

  async function academy(label: string, policy: 'open' | 'invite' | 'approval' = 'open') {
    const owner = await existingAccount(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const a = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({
      where: { id: a.id },
      data: { status: 'active', registrationPolicy: policy },
    });
    await seedAcademyMember(admin, a.id, owner.userId, 'owner');
    const host = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.enum.test`;
    await admin.domainConnection.create({
      data: { academyId: a.id, hostname: host, status: 'connected' },
    });
    return { id: a.id, host, owner };
  }

  it('ENUM-01 — platform sign-up: an existing address gets the new-address answer; nothing is created; the owner is emailed once an hour', async () => {
    const existing = await existingAccount('enum01');
    const fresh = uniqueTestEmail('enum01-new');
    const forExisting = await register({
      name: 'Someone',
      email: existing.email,
      password: 'another-password-1',
    }).expect(201);
    const forNew = await register({
      name: 'Someone',
      email: fresh,
      password: 'another-password-1',
    }).expect(201);
    expect(forExisting.body).toEqual(forNew.body);
    expect(forExisting.body).toEqual({ account: 'new' });
    expect(await admin.user.count({ where: { email: existing.email } })).toBe(1);
    // The existing account is untouched: its own password still works.
    await http()
      .post('/auth/sign-in')
      .send({ email: existing.email, password: PASSWORD })
      .expect(200);
    expect(await notices(existing.userId)).toBe(1);
    // A second attempt within the hour does not mail again.
    await register({
      name: 'Someone',
      email: existing.email,
      password: 'another-password-2',
    }).expect(201);
    expect(await notices(existing.userId)).toBe(1);
  });

  it('ENUM-02 — organization sign-up: the same answer; rule failures identical for both', async () => {
    const existing = await existingAccount('enum02');
    const fresh = uniqueTestEmail('enum02-new');
    const orgsBefore = await admin.organization.count({
      where: { ownerUserId: existing.userId },
    });
    for (const email of [existing.email, fresh]) {
      const bad = await register({
        name: 'Owner',
        email,
        password: PASSWORD,
        organizationName: 'x',
      }).expect(400);
      expect(bad.body.error.messageKey).toBe('errors.validation.failed');
    }
    // W4 — one unique name for both: the decoy (existing address) creates
    // nothing, the fresh address creates it, and both must answer alike.
    const enumOrg = uniqueName('Enum Org');
    const errorless = (body: { error?: { requestId?: string } }) =>
      body.error ? { ...body, error: { ...body.error, requestId: undefined } } : body;
    const a = await register({
      name: 'Owner',
      email: existing.email,
      password: PASSWORD,
      organizationName: enumOrg,
    });
    const b = await register({
      name: 'Owner',
      email: fresh,
      password: PASSWORD,
      organizationName: enumOrg,
    });
    expect(a.status).toBe(201);
    expect(a.status).toBe(b.status);
    expect(errorless(a.body)).toEqual(errorless(b.body));
    expect(
      await admin.organization.count({ where: { ownerUserId: existing.userId } }),
    ).toBe(orgsBefore);
  });

  it('ENUM-03 — academy (open): wrong password → new-address answer, not joined, owner emailed; right password joins', async () => {
    const a = await academy('enum03');
    const existing = await existingAccount('enum03-person');
    const wrong = await register(
      {
        name: 'Person',
        email: existing.email,
        password: 'wrong-password-1',
        academyId: a.id,
      },
      a.host,
    ).expect(201);
    const fresh = await register(
      {
        name: 'Person',
        email: uniqueTestEmail('enum03-new'),
        password: 'wrong-password-1',
        academyId: a.id,
      },
      a.host,
    ).expect(201);
    expect(wrong.body).toEqual(fresh.body);
    expect(
      await admin.academyStudent.count({
        where: { userId: existing.userId, academyId: a.id },
      }),
    ).toBe(0);
    expect(await notices(existing.userId)).toBe(1);
    await flush();
    const joined = await register(
      { name: 'Person', email: existing.email, password: PASSWORD, academyId: a.id },
      a.host,
    ).expect(201);
    expect(joined.body).toMatchObject({ account: 'existing', status: 'active' });
  });

  it('ENUM-04 — academy (invite-only): a bad code is inviteInvalid for both; a valid code is not spent by an unproven existing address', async () => {
    const a = await academy('enum04', 'invite');
    const existing = await existingAccount('enum04-person');
    for (const email of [existing.email, uniqueTestEmail('enum04-new')]) {
      await flush();
      const res = await register(
        {
          name: 'Pat',
          email,
          password: 'wrong-password-1',
          academyId: a.id,
          inviteToken: 'not-a-code',
        },
        a.host,
      ).expect(400);
      expect(res.body.error.messageKey).toBe('errors.auth.inviteInvalid');
    }
    const raw = generateOpaqueToken();
    const invite = await admin.academyInvite.create({
      data: {
        academyId: a.id,
        tokenHash: hashOpaqueToken(raw),
        createdBy: a.owner.userId,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await flush();
    await register(
      {
        name: 'Pat',
        email: existing.email,
        password: 'wrong-password-1',
        academyId: a.id,
        inviteToken: raw,
      },
      a.host,
    ).expect(201);
    const after = await admin.academyInvite.findUniqueOrThrow({
      where: { id: invite.id },
    });
    expect(after.usedCount).toBe(0);
    // The code still works for its real recipient.
    const newcomer = uniqueTestEmail('enum04-newcomer');
    await register(
      {
        name: 'Nour',
        email: newcomer,
        password: PASSWORD,
        academyId: a.id,
        inviteToken: raw,
      },
      a.host,
    ).expect(201);
    expect(
      (await admin.academyInvite.findUniqueOrThrow({ where: { id: invite.id } }))
        .usedCount,
    ).toBe(1);
  });

  it('ENUM-05 — invited and Google-only accounts get the same generic answer', async () => {
    const invitedEmail = uniqueTestEmail('enum05-invited');
    const invited = await admin.user.create({
      data: {
        email: invitedEmail,
        name: 'Invited',
        status: 'invited',
      },
    });
    const googleEmail = uniqueTestEmail('enum05-google');
    const google = await admin.user.create({
      data: {
        email: googleEmail,
        name: 'Google',
        emailVerifiedAt: new Date(),
      },
    });
    for (const email of [invitedEmail, googleEmail]) {
      const res = await register({ name: 'Someone', email, password: PASSWORD }).expect(
        201,
      );
      expect(res.body).toEqual({ account: 'new' });
    }
    expect(
      (await admin.user.findUniqueOrThrow({ where: { id: invited.id } })).status,
    ).toBe('invited');
    expect(await notices(invited.id)).toBe(1);
    expect(await notices(google.id)).toBe(1);
  });

  it('ENUM-06 — an academy sign-up meters every address alike', async () => {
    const a = await academy('enum06');
    const existing = await existingAccount('enum06-person');
    const fresh = uniqueTestEmail('enum06-new');
    for (const email of [existing.email, fresh]) {
      await flush();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        const res = await register(
          { name: 'Pat', email, password: `wrong-password-${i}`, academyId: a.id },
          a.host,
        );
        statuses.push(res.status);
        // Both keep answering identically until the per-address budget ends.
        if (res.status === 429) break;
        await admin.user.deleteMany({ where: { email: fresh } });
      }
      expect(statuses.at(-1)).toBe(429);
    }
  });
});
