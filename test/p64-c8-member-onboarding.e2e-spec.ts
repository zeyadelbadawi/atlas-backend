/**
 * P64 Communications C8 — the onboarding email for an account somebody
 * else created for you.
 *
 * THE GAP THIS CLOSES. A Client Owner adding a Manager, Instructor or
 * Student typed a password into the create call and the new person was
 * told NOTHING: no email, no link, no way to learn the account existed.
 * Either the owner relayed a password out of band, or the account sat
 * unusable. Emailing a generated password would have been worse than
 * both.
 *
 * WHAT IS ASSERTED. That each of the three roles actually receives a
 * message; that it carries a one-time SETUP LINK and never a password or
 * a bare token; that following the link genuinely sets a password the
 * person can then sign in with — which is the only proof that matters,
 * because a link that arrives and does not work is the same failure as no
 * link at all; and that an EXISTING Atlas user added to a second academy
 * is not sent one, since they already have a password.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { StubEmailProvider } from '../src/communications/providers/stub-email.provider';

jest.setTimeout(120000);
const PASSWORD = 'correct-horse-battery';

describe('P64 C8 — academy member onboarding (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let stub: StubEmailProvider;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    stub = testApp.stubEmailProvider;
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function signUpAndSignIn(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      accessToken: signIn.body.accessToken as string,
    };
  }

  /** An owner with a subscribed organization and one provisioned academy. */
  async function seedOwnerWithAcademy(label: string) {
    const owner = await signUpAndSignIn(label);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, org.slug);
    // Academies are created through PROVISIONING, not a direct POST —
    // the direct route was removed because it skipped subdomain
    // allocation. Poll for the row the worker writes.
    const slug = `${label}-${Date.now()}`;
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: `${label} Academy`,
        requestedSubdomain: slug,
        idempotencyKey: `${slug}-${Date.now()}`,
      })
      .expect((res) => {
        if (res.status >= 400) {
          throw new Error(`provisioning failed: ${res.status} ${res.text}`);
        }
      });
    let academyId: string | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const row = await admin.academy.findFirst({ where: { slug } });
      if (row) {
        academyId = row.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!academyId) throw new Error(`Provisioning produced no Academy for ${slug}`);
    return { owner, org, academyId };
  }

  /**
   * The setup email is emitted to the outbox and sent by the dispatcher,
   * so it arrives a moment after the create call returns. The stub
   * recovers the token from the LINK, which is also the assertion that
   * the value is inside a URL rather than pasted into the body.
   */
  async function waitForSetupToken(email: string): Promise<string> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const sent = stub
        .recordedSends()
        .filter((s) => s.to.toLowerCase() === email.toLowerCase());
      const last = sent[sent.length - 1];
      if (last) {
        // Pulled out of the CTA's href — which is also the assertion that
        // the credential is in a URL and not pasted into the body. The
        // stub's `peekLastPasswordResetToken` helper does not apply here:
        // it files by the `auth.password.reset` tag, and this event
        // carries its own.
        const source = `${last.html ?? ''}\n${last.text}`;
        for (const match of source.matchAll(/https?:\/\/[^\s<>"']+/g)) {
          try {
            const token = new URL(match[0]).searchParams.get('token');
            if (token) return token;
          } catch {
            continue;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`No account-setup email reached the stub for ${email}`);
  }

  /** Everything the recipient can read, with URLs removed. */
  function visibleNonUrlText(email: string): string {
    const sent = stub
      .recordedSends()
      .filter((s) => s.to.toLowerCase() === email.toLowerCase());
    const last = sent[sent.length - 1];
    if (!last) throw new Error(`No send recorded for ${email}`);
    return `${last.subject}\n${(last.html ?? '').replace(/<[^>]*>/g, ' ')}\n${last.text}`.replace(
      /https?:\/\/\S+/g,
      ' ',
    );
  }

  describe.each([
    ['student', '/students', (id: string) => `/academies/${id}/students`],
    ['instructor', '/instructors', (id: string) => `/academies/${id}/instructors`],
    ['manager', '/members', (id: string) => `/academies/${id}/members`],
  ])('a staff-created %s', (role, _label, pathFor) => {
    it('receives a setup link, and can use it to sign in', async () => {
      const { owner, academyId } = await seedOwnerWithAcademy(`c8-${role}`);
      const email = uniqueTestEmail(`c8-${role}-member`);

      await request(app.getHttpServer())
        .post(pathFor(academyId))
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ name: `New ${role}`, email, password: PASSWORD })
        .expect((res) => {
          if (![200, 201].includes(res.status)) {
            throw new Error(`create ${role} failed: ${res.status} ${res.text}`);
          }
        });

      // 1. An email arrived, and its token was recoverable from a LINK.
      const token = await waitForSetupToken(email);
      expect(token).toBeTruthy();

      // 2. It never shows the token, and never a password.
      const visible = visibleNonUrlText(email);
      expect(visible).not.toContain(token);
      expect(visible).not.toContain(PASSWORD);
      expect(visible.toLowerCase()).not.toContain('token');

      // 3. THE PROOF: the link actually works. A setup link that arrives
      //    and cannot set a password is the same failure as no link.
      const chosen = 'a-password-i-chose-myself';
      await request(app.getHttpServer())
        .post('/auth/password-reset/confirm')
        .send({ token, newPassword: chosen })
        .expect((res) => {
          if (![200, 204].includes(res.status)) {
            throw new Error(`confirm failed: ${res.status} ${res.text}`);
          }
        });

      // A learner signs in on their ACADEMY surface; staff on the
      // management one. Signing a learner in on the management surface is
      // refused with 403 by design, so asserting a management sign-in for
      // all three roles would be asserting the wrong contract — and is
      // exactly why the learner's setup link points at the academy host.
      const signIn = await request(app.getHttpServer())
        .post('/auth/sign-in')
        .send(
          role === 'student'
            ? { email, password: chosen, surface: 'academy', academyId }
            : { email, password: chosen },
        )
        .expect(200);
      expect(signIn.body.accessToken).toBeTruthy();
    });
  });

  it('does NOT re-onboard an existing Atlas user added to a second academy', async () => {
    // They already have a password and know what Atlas is; a "set your
    // password" email would be confusing at best.
    const existing = await signUpAndSignIn('c8-existing');
    const { owner, academyId } = await seedOwnerWithAcademy('c8-second');

    await request(app.getHttpServer())
      .post(`/academies/${academyId}/members`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'Existing User', email: existing.email, password: PASSWORD })
      .expect((res) => {
        if (![200, 201].includes(res.status)) {
          throw new Error(`add member failed: ${res.status} ${res.text}`);
        }
      });

    // Give the dispatcher the same window the positive cases get.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(
      await admin.communicationOutbox.count({
        where: { key: 'academy.member.invited', recipientUserId: existing.userId },
      }),
    ).toBe(0);
  });
});
