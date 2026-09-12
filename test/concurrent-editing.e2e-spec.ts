/**
 * Concurrent CMS editing — optimistic concurrency and editing presence.
 *
 * THE BUG THIS SUITE EXISTS FOR. `website_pages.sections` holds a page's
 * entire composition in one column, so every save is a full replace. Two
 * admins with the same page open — an owner and a manager, which is the
 * ordinary staffing of an Academy, not an exotic edge case — meant the
 * second save silently destroyed the first. No error, no warning, nothing
 * in any log to show it had happened. The victim finds out later, if ever.
 *
 * The tests are written to the brief's own A–F list, and the load-bearing
 * one is A: it asserts not merely that the stale save is REFUSED, but that
 * the winner's content is still there afterwards. A conflict response that
 * still clobbered the row would satisfy a weaker assertion.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

async function signUpAndSignIn(
  app: INestApplication,
  label: string,
): Promise<{ userId: string; accessToken: string }> {
  const email = uniqueTestEmail(label);
  const password = 'correct-horse-battery';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: label, email, password })
    .expect(201);
  const signIn = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password })
    .expect(200);
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

describe('Concurrent CMS editing (e2e)', () => {
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

  /** An academy with an owner and a manager — the two people who collide in practice. */
  async function seedSharedAcademy(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

    // A real manager needs BOTH rows: `AcademyScopeGuard` resolves the
    // academy through organization membership before any service-level role
    // check runs, so an academy_members row on its own is not a real
    // manager — it is a user the guard rejects at the door.
    const manager = await signUpAndSignIn(app, `${label}-manager`);
    await seedMembership(admin, org.id, manager.userId, 'manager');
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');

    // First read bootstraps the configuration and the core pages.
    const pages = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    return { owner, manager, org, academy, page: pages.body.items[0] };
  }

  function loadPage(academyId: string, pageId: string, accessToken: string) {
    return request(app.getHttpServer())
      .get(`/academies/${academyId}/website/pages/${pageId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  }

  // --- A. The lost update ---------------------------------------------------

  it('A: a stale save is refused with a deterministic conflict, and the first save survives intact', async () => {
    const { owner, manager, academy, page } = await seedSharedAcademy('cc-lost-update');

    const asOwner = await loadPage(academy.id, page.id, owner.accessToken);
    const asManager = await loadPage(academy.id, page.id, manager.accessToken);
    expect(asOwner.body.version).toBe(asManager.body.version);
    const sharedVersion = asOwner.body.version;

    // The owner saves first and wins the version.
    const ownerSave = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Owner edition', expectedVersion: sharedVersion })
      .expect(200);
    expect(ownerSave.body.version).toBe(sharedVersion + 1);

    // The manager saves the copy they loaded before that.
    const conflict = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ title: 'Manager edition', expectedVersion: sharedVersion })
      .expect(409);

    expect(conflict.body.error.kind).toBe('conflict');
    expect(conflict.body.error.code).toBe('stale_resource_version');
    expect(conflict.body.error.details.currentVersion).toBe(sharedVersion + 1);
    expect(conflict.body.error.details.submittedVersion).toBe(sharedVersion);

    // THE POINT OF THE WHOLE MECHANISM: the owner's work is still there.
    const after = await loadPage(academy.id, page.id, owner.accessToken);
    expect(after.body.title).toBe('Owner edition');
    expect(after.body.version).toBe(sharedVersion + 1);
  });

  it('A2: the conflict names whoever saved the current version', async () => {
    const { owner, manager, academy, page } = await seedSharedAcademy('cc-names');
    const loaded = await loadPage(academy.id, page.id, manager.accessToken);

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Saved by the owner', expectedVersion: loaded.body.version })
      .expect(200);

    const conflict = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ title: 'Too late', expectedVersion: loaded.body.version })
      .expect(409);

    // The owner registered as `cc-names-owner`; the name is the real one
    // from `users`, not a placeholder.
    expect(conflict.body.error.details.lastEditedByName).toContain('cc-names-owner');
  });

  it('A3: retrying against the version the conflict reported succeeds', async () => {
    const { owner, manager, academy, page } = await seedSharedAcademy('cc-retry');
    const loaded = await loadPage(academy.id, page.id, manager.accessToken);

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'First', expectedVersion: loaded.body.version })
      .expect(200);

    const conflict = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ title: 'Second', expectedVersion: loaded.body.version })
      .expect(409);

    // "Take over" is exactly this: re-based on the CURRENT version, never a
    // bypass of the check.
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Second, rebased',
        expectedVersion: conflict.body.error.details.currentVersion,
      })
      .expect(200);

    const after = await loadPage(academy.id, page.id, owner.accessToken);
    expect(after.body.title).toBe('Second, rebased');
  });

  // --- F. Concurrency, not just sequencing ----------------------------------

  it('F: two simultaneous saves of the same version cannot both succeed', async () => {
    const { owner, manager, academy, page } = await seedSharedAcademy('cc-simultaneous');
    const loaded = await loadPage(academy.id, page.id, owner.accessToken);
    const version = loaded.body.version;

    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .patch(`/academies/${academy.id}/website/pages/${page.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ title: 'Racer A', expectedVersion: version }),
      request(app.getHttpServer())
        .patch(`/academies/${academy.id}/website/pages/${page.id}`)
        .set('Authorization', `Bearer ${manager.accessToken}`)
        .send({ title: 'Racer B', expectedVersion: version }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    // Exactly one winner, and the row reflects that winner — never a blend.
    const after = await loadPage(academy.id, page.id, owner.accessToken);
    expect(['Racer A', 'Racer B']).toContain(after.body.title);
    expect(after.body.version).toBe(version + 1);
  });

  /*
   * This test used to assert the OPPOSITE — that a version-less save still
   * succeeded, "for callers predating the field". That leniency was
   * justified by the claim that every Atlas caller sent the token, and an
   * audit found that claim false: the SEO dialog (which replaces the whole
   * `seo` object) and the pages-list visibility toggle both omitted it, so
   * a second admin saving a stale SEO dialog silently destroyed the first
   * one's work through exactly this hole.
   *
   * The token is now required. Nothing legitimate needs the old path: this
   * endpoint has no external contract (Swagger is disabled in production),
   * nothing but the HTTP route reaches the service, and every Atlas caller
   * sends it.
   */
  it('a save that omits expectedVersion is refused, not silently applied', async () => {
    const { owner, academy, page } = await seedSharedAcademy('cc-legacy');

    const refused = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'No token supplied' })
      .expect(400);

    // Actionable and specific, not a field-level validation violation on a
    // control the user never filled in.
    expect(refused.body.error.messageKey).toBe('errors.website.versionRequired');
    expect(refused.body.error.violations).toBeUndefined();

    // The write did not happen: same title, same version, nothing consumed.
    const after = await loadPage(academy.id, page.id, owner.accessToken);
    expect(after.body.title).toBe(page.title);
    expect(after.body.version).toBe(page.version);
  });

  // --- B, C. Presence -------------------------------------------------------

  it('B: a second editor sees the first one, with their real name and role', async () => {
    const { owner, manager, academy, page } = await seedSharedAcademy('cc-presence');

    const ownerFirst = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${page.id}/editing-session`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    // Nobody else is editing yet.
    expect(ownerFirst.body.participants).toEqual([]);

    const managerView = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${page.id}/editing-session`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);

    expect(managerView.body.participants).toHaveLength(1);
    expect(managerView.body.participants[0].userId).toBe(owner.userId);
    expect(managerView.body.participants[0].role).toBe('owner');
    expect(managerView.body.participants[0].name).toContain('cc-presence-owner');

    // And it is mutual on the owner's next heartbeat.
    const ownerAgain = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${page.id}/editing-session`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(ownerAgain.body.participants.map((p: { userId: string }) => p.userId)).toEqual(
      [manager.userId],
    );
  });

  it('C: releasing a session frees the resource immediately, without waiting out the TTL', async () => {
    const { owner, manager, academy, page } = await seedSharedAcademy('cc-release');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${page.id}/editing-session`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/website/pages/${page.id}/editing-session`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    const managerView = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${page.id}/editing-session`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(200);
    expect(managerView.body.participants).toEqual([]);
  });

  it('C2: presence never blocks a save — the other editor can still write', async () => {
    const { owner, manager, academy, page } = await seedSharedAcademy('cc-nonblocking');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${page.id}/editing-session`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    const loaded = await loadPage(academy.id, page.id, manager.accessToken);

    // The owner is announced as editing; the manager saves anyway. Presence
    // is advice, not a lock — a crashed tab must never freeze a page.
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({
        title: 'Written while another editor is present',
        expectedVersion: loaded.body.version,
      })
      .expect(200);
  });

  // --- D, E. Authorisation of the concurrency endpoints ---------------------

  it('D: a user from another academy cannot open an editing session on this page', async () => {
    const { academy, page } = await seedSharedAcademy('cc-cross-a');
    const other = await seedSharedAcademy('cc-cross-b');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${page.id}/editing-session`)
      .set('Authorization', `Bearer ${other.owner.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .delete(`/academies/${academy.id}/website/pages/${page.id}/editing-session`)
      .set('Authorization', `Bearer ${other.owner.accessToken}`)
      .expect(403);
  });

  it("D2: a page id from another academy is not reachable through this academy's path", async () => {
    const { owner, academy } = await seedSharedAcademy('cc-idor-a');
    const other = await seedSharedAcademy('cc-idor-b');

    // A real page id, a real academy the caller really manages — but the
    // page belongs to someone else. Must not resolve.
    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${other.page.id}/editing-session`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });

  it('E: a student and an unauthenticated caller cannot use the concurrency endpoints', async () => {
    const { academy, page } = await seedSharedAcademy('cc-roles');
    const student = await signUpAndSignIn(app, 'cc-roles-student');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${page.id}/editing-session`)
      .set('Authorization', `Bearer ${student.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${page.id}/editing-session`)
      .expect(401);
  });

  it('E2: an instructor cannot open an editing session on a website page', async () => {
    const { academy, org, page } = await seedSharedAcademy('cc-instructor');
    const instructor = await signUpAndSignIn(app, 'cc-instructor-user');
    await seedMembership(admin, org.id, instructor.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/pages/${page.id}/editing-session`)
      .set('Authorization', `Bearer ${instructor.accessToken}`)
      .expect(403);
  });
});
