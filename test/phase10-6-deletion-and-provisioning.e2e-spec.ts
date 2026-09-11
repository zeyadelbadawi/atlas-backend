/**
 * Phase 10.6 — account deletion, Academy deletion, entitlement release,
 * and Academy Provisioning as the single creation path
 * (P106-DEL-001..020).
 *
 * WHY ACCOUNT DELETION IS ANONYMISATION. `users` is referenced by 47
 * foreign keys and several are ON DELETE RESTRICT — `audit_log_entries`,
 * `organizations.owner_user_id`, `blog_posts`, `forum_threads`,
 * `forum_replies`, `announcements`, `payment_reviews`,
 * `provisioning_requests`, `course_order_refunds`. Any account that has
 * done anything has audit rows, so a hard delete is refused by the
 * database for essentially every real user. These tests therefore assert
 * that the PERSON is gone and can never authenticate — not that a row
 * vanished.
 *
 * WHY THE MEMBERSHIP ASSERTIONS ARE HERE. Three separate RLS traps were
 * found while building this, and every one of them FAILED SILENTLY while
 * reporting success: a `deleteMany` with no tenant context, three tables
 * with no DELETE policy at all, and an RLS-blocked lookup that returned
 * an empty list so the loop never ran. In each case the account looked
 * deleted and the memberships survived. P106-DEL-004 exists specifically
 * so that cannot regress unnoticed.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

describe('Phase 10.6 deletion & provisioning (e2e) — P106-DEL-001..020', () => {
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

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Deletion Tester', email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      token: signIn.body.accessToken as string,
      userId: signIn.body.user.id as string,
    };
  }

  /** An owner with an organization and a live trial, so entitlement permits an Academy. */
  async function seedOwner(label: string) {
    const account = await signUp(label);
    const org = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${account.token}`)
      .send({ name: `${label} org ${Date.now()}` })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/organizations/${org.body.id}/subscription/trial`)
      .set('Authorization', `Bearer ${account.token}`)
      .send({ confirm: true })
      .expect(200);
    return { ...account, organizationId: org.body.id as string };
  }

  /**
   * Creates an Academy the way the application now does it — through
   * provisioning. Returns the Academy row once it exists.
   */
  async function provisionAcademy(
    token: string,
    organizationId: string,
    slug: string,
  ): Promise<{ status: number; academyId?: string }> {
    const response = await request(app.getHttpServer())
      .post(`/organizations/${organizationId}/provisioning-requests`)
      .set('Authorization', `Bearer ${token}`)
      // `idempotencyKey` is required by the contract — provisioning is
      // asynchronous and retryable, so every request must be
      // deduplicable.
      .send({
        academyName: `Academy ${slug}`,
        requestedSubdomain: slug,
        idempotencyKey: `${slug}-${Date.now()}`,
      });

    if (response.status >= 400) return { status: response.status };

    // Provisioning is asynchronous; wait for the Academy row to appear.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const academy = await admin.academy.findFirst({ where: { slug } });
      if (academy) return { status: response.status, academyId: academy.id };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { status: response.status };
  }

  // ---------------- account deletion ----------------

  it('P106-DEL-001 — deletion requires explicit confirmation', async () => {
    const account = await signUp('p106-001');

    await request(app.getHttpServer())
      .post('/users/me/delete')
      .set('Authorization', `Bearer ${account.token}`)
      .send({})
      .expect(400);

    // Still usable.
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${account.token}`)
      .expect(200);
  });

  it('P106-DEL-002 — an unauthenticated caller cannot delete anything', async () => {
    await request(app.getHttpServer())
      .post('/users/me/delete')
      .send({ confirm: true })
      .expect(401);
  });

  it('P106-DEL-003 — a user can delete their own account, and it is anonymised', async () => {
    const account = await signUp('p106-003');

    const response = await request(app.getHttpServer())
      .post('/users/me/delete')
      .set('Authorization', `Bearer ${account.token}`)
      .send({ confirm: true, reason: 'no_longer_needed' })
      .expect(200);

    expect(response.body.deleted).toBe(true);

    const user = await admin.user.findUniqueOrThrow({ where: { id: account.userId } });
    expect(user.status).toBe('deleted');
    expect(user.deletedAt).toBeInstanceOf(Date);
    // The original address is gone, not merely flagged.
    expect(user.email).not.toBe(account.email);
    expect(user.email).toMatch(/@account\.invalid$/);
    expect(user.name).toBe('Deleted account');
    expect(user.avatarUrl).toBeNull();
    expect(user.emailVerifiedAt).toBeNull();
    // No password can produce this, so authentication is impossible even
    // if a future code path forgot the status check.
    expect(user.passwordHash.startsWith('deleted:')).toBe(true);
  });

  it('P106-DEL-004 — deletion actually removes memberships (the silent-RLS regression guard)', async () => {
    const owner = await seedOwner('p106-004');

    await request(app.getHttpServer())
      .post('/users/me/delete')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ confirm: true })
      .expect(200);

    // Every one of these was silently left behind at some point while
    // building this, while the endpoint still reported success.
    expect(
      await admin.organizationMembership.count({ where: { userId: owner.userId } }),
    ).toBe(0);
    expect(await admin.academyMember.count({ where: { userId: owner.userId } })).toBe(0);
    expect(await admin.academyStudent.count({ where: { userId: owner.userId } })).toBe(0);
  });

  it('P106-DEL-005 — every session dies immediately and sign-in is impossible', async () => {
    const account = await signUp('p106-005');
    // A second device, to prove ALL sessions die and not just the caller's.
    const second = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);

    await request(app.getHttpServer())
      .post('/users/me/delete')
      .set('Authorization', `Bearer ${account.token}`)
      .send({ confirm: true })
      .expect(200);

    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${account.token}`)
      .expect(401);
    await request(app.getHttpServer())
      .get('/users/me')
      .set('Authorization', `Bearer ${second.body.accessToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .send({ refreshToken: second.body.refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(401);

    expect(
      await admin.refreshToken.count({
        where: { userId: account.userId, revokedAt: null },
      }),
    ).toBe(0);
  });

  it('P106-DEL-006 — authentication material is destroyed', async () => {
    const account = await signUp('p106-006');
    await request(app.getHttpServer())
      .post('/auth/2fa/setup')
      .set('Authorization', `Bearer ${account.token}`)
      .expect(200);

    await request(app.getHttpServer())
      .post('/users/me/delete')
      .set('Authorization', `Bearer ${account.token}`)
      .send({ confirm: true })
      .expect(200);

    expect(await admin.userTwoFactor.count({ where: { userId: account.userId } })).toBe(
      0,
    );
    expect(
      await admin.twoFactorRecoveryCode.count({ where: { userId: account.userId } }),
    ).toBe(0);
    expect(
      await admin.emailVerificationToken.count({ where: { userId: account.userId } }),
    ).toBe(0);
  });

  it('P106-DEL-007 — a PLATFORM OWNER is refused the self-delete endpoint', async () => {
    const account = await signUp('p106-007');
    await admin.user.update({
      where: { id: account.userId },
      data: { isPlatformOwner: true },
    });

    const fresh = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);

    await request(app.getHttpServer())
      .post('/users/me/delete')
      .set('Authorization', `Bearer ${fresh.body.accessToken}`)
      .send({ confirm: true })
      .expect(403);

    // Untouched.
    const user = await admin.user.findUniqueOrThrow({ where: { id: account.userId } });
    expect(user.status).toBe('active');
  });

  it('P106-DEL-008 — deletion is idempotent', async () => {
    const account = await signUp('p106-008');
    await request(app.getHttpServer())
      .post('/users/me/delete')
      .set('Authorization', `Bearer ${account.token}`)
      .send({ confirm: true })
      .expect(200);

    // The token is dead, so a second attempt cannot even authenticate —
    // which is itself the safe outcome for a retried request.
    await request(app.getHttpServer())
      .post('/users/me/delete')
      .set('Authorization', `Bearer ${account.token}`)
      .send({ confirm: true })
      .expect(401);
  });

  it('P106-DEL-009 — there is no user-id parameter to point at someone else', async () => {
    // Horizontal privilege escalation is absent by construction: the
    // route has no id, so this asserts that no id-bearing variant exists.
    const victim = await signUp('p106-009-victim');
    const attacker = await signUp('p106-009-attacker');

    for (const path of [`/users/${victim.userId}/delete`, `/users/${victim.userId}`]) {
      const response = await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${attacker.token}`)
        .send({ confirm: true });
      expect([401, 403, 404]).toContain(response.status);
    }

    // Sending a userId in the BODY must also change nothing.
    await request(app.getHttpServer())
      .post('/users/me/delete')
      .set('Authorization', `Bearer ${attacker.token}`)
      .send({ confirm: true, userId: victim.userId })
      .expect(400);

    const stillThere = await admin.user.findUniqueOrThrow({
      where: { id: victim.userId },
    });
    expect(stillThere.status).toBe('active');
  });

  it('P106-DEL-010 — an owner deleting their account archives their academies', async () => {
    const owner = await seedOwner('p106-010');
    const slug = `p106ten${Date.now()}`;
    const provisioned = await provisionAcademy(owner.token, owner.organizationId, slug);
    expect(provisioned.academyId).toBeTruthy();

    const response = await request(app.getHttpServer())
      .post('/users/me/delete')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ confirm: true })
      .expect(200);

    expect(response.body.academiesArchived).toBeGreaterThan(0);
    const academy = await admin.academy.findUniqueOrThrow({
      where: { id: provisioned.academyId },
    });
    expect(academy.status).toBe('archived');
  });

  // ---------------- Academy Provisioning as the ONLY creation path ----------------

  it('P106-DEL-011 — the direct POST /academies creation route no longer exists', async () => {
    // The bypass that caused the dead-public-website outage: it created
    // an Academy without the subdomain allocation provisioning performs.
    const owner = await seedOwner('p106-011');

    const response = await request(app.getHttpServer())
      .post('/academies')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        organizationId: owner.organizationId,
        name: 'Bypass Academy',
        slug: `bypass${Date.now()}`,
      });

    expect(response.status).toBe(404);
  });

  it('P106-DEL-012 — provisioning creates the Academy AND its subdomain allocation', async () => {
    const owner = await seedOwner('p106-012');
    const slug = `p106twelve${Date.now()}`;

    const provisioned = await provisionAcademy(owner.token, owner.organizationId, slug);
    expect(provisioned.academyId).toBeTruthy();

    const allocation = await admin.subdomainAllocation.findUnique({
      where: { academyId: provisioned.academyId! },
    });
    expect(allocation).toBeTruthy();
    expect(allocation?.subdomain).toBe(slug);
    expect(allocation?.status).toBe('assigned');
  });

  it('P106-DEL-013 — a provisioned Academy resolves publicly', async () => {
    const owner = await seedOwner('p106-013');
    const slug = `p106thirteen${Date.now()}`;
    await provisionAcademy(owner.token, owner.organizationId, slug);

    const resolved = await request(app.getHttpServer())
      .get(`/public/websites/resolve?hostname=${slug}`)
      .expect(200);
    expect(resolved.body.academySlug).toBe(slug);
  });

  it('P106-DEL-014 — unauthorized roles cannot start provisioning', async () => {
    const owner = await seedOwner('p106-014');
    const outsider = await signUp('p106-014-outsider');

    const response = await request(app.getHttpServer())
      .post(`/organizations/${owner.organizationId}/provisioning-requests`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({
        academyName: 'Cross tenant',
        requestedSubdomain: `x${Date.now()}`,
        idempotencyKey: `cross-${Date.now()}`,
      });

    expect([403, 404]).toContain(response.status);
  });

  it('P106-DEL-015 — an unauthenticated caller cannot start provisioning', async () => {
    const owner = await seedOwner('p106-015');
    await request(app.getHttpServer())
      .post(`/organizations/${owner.organizationId}/provisioning-requests`)
      .send({
        academyName: 'Anon',
        requestedSubdomain: `y${Date.now()}`,
        idempotencyKey: `anon-${Date.now()}`,
      })
      .expect(401);
  });

  // ---------------- Academy deletion & entitlement release ----------------

  it('P106-DEL-016 — deleting an Academy takes its public website offline', async () => {
    const owner = await seedOwner('p106-016');
    const slug = `p106sixteen${Date.now()}`;
    const provisioned = await provisionAcademy(owner.token, owner.organizationId, slug);

    // Live first.
    await request(app.getHttpServer())
      .get(`/public/websites/resolve?hostname=${slug}`)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/academies/${provisioned.academyId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);

    // The resolver used to have no status filter at all, so a deleted
    // Academy kept serving its site indefinitely.
    await request(app.getHttpServer())
      .get(`/public/websites/resolve?hostname=${slug}`)
      .expect(404);
  });

  it('P106-DEL-017 — deleting an Academy releases the plan allowance and a replacement can be created', async () => {
    // The headline product requirement: a one-Academy plan must let the
    // owner replace a mistakenly-created Academy.
    const owner = await seedOwner('p106-017');
    const stamp = Date.now();

    const first = await provisionAcademy(
      owner.token,
      owner.organizationId,
      `p106a${stamp}`,
    );
    expect(first.academyId).toBeTruthy();

    await request(app.getHttpServer())
      .delete(`/academies/${first.academyId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(204);

    const replacement = await provisionAcademy(
      owner.token,
      owner.organizationId,
      `p106b${stamp}`,
    );
    expect(replacement.academyId).toBeTruthy();
    expect(replacement.academyId).not.toBe(first.academyId);

    // And the replacement is fully functional, not a half-created row.
    const allocation = await admin.subdomainAllocation.findUnique({
      where: { academyId: replacement.academyId! },
    });
    expect(allocation?.subdomain).toBe(`p106b${stamp}`);
    await request(app.getHttpServer())
      .get(`/public/websites/resolve?hostname=p106b${stamp}`)
      .expect(200);
  });

  it('P106-DEL-018 — a non-owner cannot delete an Academy', async () => {
    const owner = await seedOwner('p106-018');
    const slug = `p106eighteen${Date.now()}`;
    const provisioned = await provisionAcademy(owner.token, owner.organizationId, slug);

    const outsider = await signUp('p106-018-outsider');
    const response = await request(app.getHttpServer())
      .delete(`/academies/${provisioned.academyId}`)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect([403, 404]).toContain(response.status);

    // Untouched, and still serving.
    const academy = await admin.academy.findUniqueOrThrow({
      where: { id: provisioned.academyId },
    });
    expect(academy.status).not.toBe('archived');
  });

  it('P106-DEL-019 — an unauthenticated caller cannot delete an Academy', async () => {
    const owner = await seedOwner('p106-019');
    const slug = `p106nineteen${Date.now()}`;
    const provisioned = await provisionAcademy(owner.token, owner.organizationId, slug);

    await request(app.getHttpServer())
      .delete(`/academies/${provisioned.academyId}`)
      .expect(401);
  });

  it('P106-DEL-020 — a deleted Academy does not leak into another Academy hostname', async () => {
    const ownerA = await seedOwner('p106-020a');
    const ownerB = await seedOwner('p106-020b');
    const stamp = Date.now();
    const slugA = `p106twentya${stamp}`;
    const slugB = `p106twentyb${stamp}`;

    const academyA = await provisionAcademy(ownerA.token, ownerA.organizationId, slugA);
    const academyB = await provisionAcademy(ownerB.token, ownerB.organizationId, slugB);

    await request(app.getHttpServer())
      .delete(`/academies/${academyA.academyId}`)
      .set('Authorization', `Bearer ${ownerA.token}`)
      .expect(204);

    // A's hostname is gone; B's is unaffected and still resolves to B.
    await request(app.getHttpServer())
      .get(`/public/websites/resolve?hostname=${slugA}`)
      .expect(404);
    const resolvedB = await request(app.getHttpServer())
      .get(`/public/websites/resolve?hostname=${slugB}`)
      .expect(200);
    expect(resolvedB.body.academyId).toBe(academyB.academyId);
  });

  // ---------------- deletion with a recorded reason ----------------

  it('P106-DEL-021 — deleting with a reason records it and archives the Academy', async () => {
    const owner = await seedOwner('p106-021');
    const slug = `p106twentyone${Date.now()}`;
    const provisioned = await provisionAcademy(owner.token, owner.organizationId, slug);

    await request(app.getHttpServer())
      .post(`/academies/${provisioned.academyId}/delete`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        confirm: true,
        reason: 'created_by_mistake',
        feedback: '  I picked the wrong subdomain.  ',
      })
      .expect(204);

    const academy = await admin.academy.findUniqueOrThrow({
      where: { id: provisioned.academyId },
    });
    expect(academy.status).toBe('archived');
    expect(academy.archiveReason).toBe('created_by_mistake');
    // Trimmed, not stored with the whitespace the textarea collected.
    expect(academy.archiveFeedback).toBe('I picked the wrong subdomain.');
    expect(academy.archivedAt).toBeInstanceOf(Date);

    // Same consequence as the plain DELETE: the site goes offline.
    await request(app.getHttpServer())
      .get(`/public/websites/resolve?hostname=${slug}`)
      .expect(404);
  });

  it('P106-DEL-022 — deletion without confirmation is refused and changes nothing', async () => {
    const owner = await seedOwner('p106-022');
    const slug = `p106twentytwo${Date.now()}`;
    const provisioned = await provisionAcademy(owner.token, owner.organizationId, slug);

    for (const body of [{}, { confirm: false }, { reason: 'other' }]) {
      await request(app.getHttpServer())
        .post(`/academies/${provisioned.academyId}/delete`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send(body)
        .expect(400);
    }

    // Still live — an unconfirmed request must not take a site offline.
    const academy = await admin.academy.findUniqueOrThrow({
      where: { id: provisioned.academyId },
    });
    expect(academy.status).not.toBe('archived');
    await request(app.getHttpServer())
      .get(`/public/websites/resolve?hostname=${slug}`)
      .expect(200);
  });

  it('P106-DEL-023 — an unrecognised reason is refused rather than stored', async () => {
    // The vocabulary is closed so the answers aggregate. A route that
    // accepted arbitrary strings would make the field useless and would
    // also accept whatever a caller chose to put there.
    const owner = await seedOwner('p106-023');
    const slug = `p106twentythree${Date.now()}`;
    const provisioned = await provisionAcademy(owner.token, owner.organizationId, slug);

    await request(app.getHttpServer())
      .post(`/academies/${provisioned.academyId}/delete`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ confirm: true, reason: 'because-i-said-so' })
      .expect(400);

    const academy = await admin.academy.findUniqueOrThrow({
      where: { id: provisioned.academyId },
    });
    expect(academy.status).not.toBe('archived');
  });

  it('P106-DEL-024 — the reasoned delete route is not a weaker door than DELETE', async () => {
    // Two transports for one action is only safe if both enforce the same
    // authorization. An outsider must be refused here exactly as they are
    // refused by `DELETE /academies/:id` in P106-DEL-018.
    const owner = await seedOwner('p106-024');
    const slug = `p106twentyfour${Date.now()}`;
    const provisioned = await provisionAcademy(owner.token, owner.organizationId, slug);
    const outsider = await signUp('p106-024-outsider');

    const asOutsider = await request(app.getHttpServer())
      .post(`/academies/${provisioned.academyId}/delete`)
      .set('Authorization', `Bearer ${outsider.token}`)
      .send({ confirm: true });
    expect([403, 404]).toContain(asOutsider.status);

    await request(app.getHttpServer())
      .post(`/academies/${provisioned.academyId}/delete`)
      .send({ confirm: true })
      .expect(401);

    const academy = await admin.academy.findUniqueOrThrow({
      where: { id: provisioned.academyId },
    });
    expect(academy.status).not.toBe('archived');
  });

  it('P106-DEL-025 — deleting with a reason still releases the plan allowance', async () => {
    // The reason field must not have changed what deletion DOES.
    const owner = await seedOwner('p106-025');
    const stamp = Date.now();

    const first = await provisionAcademy(
      owner.token,
      owner.organizationId,
      `p106c${stamp}`,
    );
    await request(app.getHttpServer())
      .post(`/academies/${first.academyId}/delete`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ confirm: true, reason: 'replacing_with_another' })
      .expect(204);

    const replacement = await provisionAcademy(
      owner.token,
      owner.organizationId,
      `p106d${stamp}`,
    );
    expect(replacement.academyId).toBeTruthy();
    expect(replacement.academyId).not.toBe(first.academyId);
  });
});
