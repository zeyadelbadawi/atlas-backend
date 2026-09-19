/**
 * P64 Phase 1 §T — the `surface.enforce` staged-rollout flag.
 *
 * The flag decides WHEN the management-surface refusal applies to a
 * learner. It is not a security boundary and these tests are written to
 * prove that claim rather than assert it: in every mode, including fully
 * `off`, a learner is still refused another tenant's data, still refused
 * staff actions, and still holds only their own rows. What `off` restores
 * is the pre-P64 surface behaviour — a learner may hold a management
 * session and reach the shell — and nothing else.
 *
 * The real `SurfaceEnforcementService` is used throughout, backed by a
 * configuration object the test mutates, so the logic under test is the
 * production logic and only the source of the setting is swapped.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseInstructor,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { SurfaceEnforcementService } from '../src/tenancy/services/surface-enforcement.service';
import type { SurfaceEnforcementConfig } from '../src/config/configuration';
import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

/** Mutated by each test; read on every call, exactly as the real service reads configuration. */
const flag: { value: SurfaceEnforcementConfig } = {
  value: { mode: 'on', academyIds: [] },
};

describe('P64 Phase 1 — surface.enforce staged rollout (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder.overrideProvider(SurfaceEnforcementService).useValue(
          new SurfaceEnforcementService({
            get: () => flag.value,
          } as unknown as ConfigService),
        ),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    flag.value = { mode: 'on', academyIds: [] };
    await flushRateLimitKeys();
  });

  async function staffAccount(label: string) {
    await flushRateLimitKeys();
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
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  async function world(label: string) {
    const owner = await staffAccount(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

    const manager = await staffAccount(`${label}-manager`);
    await seedMembership(admin, org.id, manager.userId, 'manager');
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');

    const instructor = await staffAccount(`${label}-instructor`);
    await seedMembership(admin, org.id, instructor.userId, 'member');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');

    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    // The instructor's roster read only exists for courses assigned to
    // them (an instructor with no assignment is refused outright), so the
    // assignment is what makes the invariance assertion below meaningful.
    await seedCourseInstructor(admin, course.id, instructor.userId);
    return { owner, manager, instructor, org, academy, course };
  }

  /** Registers a learner on `academyId` and returns them signed in on the academy surface. */
  async function learner(label: string, academyId: string) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD, academyId })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD, surface: 'academy', academyId })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  function managementSignIn(email: string) {
    return request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD, surface: 'management' });
  }

  // -------------------------------------------------------------------
  // mode: on — the end state
  // -------------------------------------------------------------------

  it('ON: refuses the learner a management session and every management controller', async () => {
    const w = await world('flag-on');
    const student = await learner('flag-on-student', w.academy.id);

    await flushRateLimitKeys();
    const refused = await managementSignIn(student.email).expect(403);
    expect(refused.body.error.messageKey).toBe('errors.auth.studentUseAcademySignIn');
    expect(refused.body.accessToken).toBeUndefined();

    const denied = await request(app.getHttpServer())
      .get('/organizations')
      .set(student.auth)
      .expect(403);
    expect(denied.body.error.messageKey).toBe('errors.auth.managementSurfaceOnly');

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set(student.auth)
      .expect(200);
    expect(me.body).toMatchObject({
      principalKind: 'learner',
      managementSurfaceEnforced: true,
    });
  });

  // -------------------------------------------------------------------
  // mode: off — the pre-P64 behaviour, for the first minutes and for rollback
  // -------------------------------------------------------------------

  it('OFF: issues the learner a management session and stops refusing the surface', async () => {
    const w = await world('flag-off');
    const student = await learner('flag-off-student', w.academy.id);

    flag.value = { mode: 'off', academyIds: [] };

    await flushRateLimitKeys();
    const session = await managementSignIn(student.email).expect(200);
    expect(session.body.accessToken).toBeDefined();
    const managementAuth = {
      Authorization: `Bearer ${session.body.accessToken as string}`,
    };

    // The surface no longer refuses them. `/subdomains/availability` is
    // guarded by the surface and nothing else, so a 200 here means exactly
    // one thing: the surface boundary let them past.
    await request(app.getHttpServer())
      .get('/subdomains/availability')
      .query({ subdomain: 'flag-off-probe' })
      .set(managementAuth)
      .expect(200);

    // An endpoint that carries its OWN authorization still refuses them —
    // and refuses them for that reason, not the surface's.
    const stillRefused = await request(app.getHttpServer())
      .get('/organizations')
      .set(managementAuth)
      .expect(403);
    expect(stillRefused.body.error.messageKey).not.toBe(
      'errors.auth.managementSurfaceOnly',
    );

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set(managementAuth)
      .expect(200);
    expect(me.body).toMatchObject({
      principalKind: 'learner',
      managementSurfaceEnforced: false,
    });
  });

  it('OFF: still refuses the learner another tenant’s data and every staff action', async () => {
    // The point of the whole flag design: `off` stages the SURFACE, and
    // grants nothing that RLS or another guard would refuse.
    const w = await world('flag-off-security');
    const other = await world('flag-off-security-other');
    const student = await learner('flag-off-security-student', w.academy.id);

    flag.value = { mode: 'off', academyIds: [] };
    await flushRateLimitKeys();
    const session = await managementSignIn(student.email).expect(200);
    const auth = { Authorization: `Bearer ${session.body.accessToken as string}` };

    // Their own academy's roster: refused, because they are not staff of it.
    await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/students`)
      .set(auth)
      .expect(403);
    // Another organization's academy: refused.
    await request(app.getHttpServer())
      .get(`/academies/${other.academy.id}/students`)
      .set(auth)
      .expect(403);
    // Staff writes on their own academy: refused.
    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/students/${student.userId}/block`)
      .set(auth)
      .send({})
      .expect(403);
    // The owner-only security policy: refused.
    await request(app.getHttpServer())
      .patch(`/academies/${w.academy.id}/registration-policy`)
      .set(auth)
      .send({ registrationPolicy: 'invite' })
      .expect(403);
    // Review and grading: refused.
    await request(app.getHttpServer())
      .get(`/review/courses/${w.course.id}/students`)
      .set(auth)
      .expect(404);
  });

  // -------------------------------------------------------------------
  // mode: allowlist — the plan's staged rollout
  // -------------------------------------------------------------------

  it('ALLOWLIST: refuses a learner of a listed academy and admits a learner of an unlisted one', async () => {
    const listed = await world('flag-listed');
    const unlisted = await world('flag-unlisted');
    const inside = await learner('flag-listed-student', listed.academy.id);
    const outside = await learner('flag-unlisted-student', unlisted.academy.id);

    flag.value = { mode: 'allowlist', academyIds: [listed.academy.id] };

    await flushRateLimitKeys();
    const refused = await managementSignIn(inside.email).expect(403);
    expect(refused.body.error.messageKey).toBe('errors.auth.studentUseAcademySignIn');

    await flushRateLimitKeys();
    const admitted = await managementSignIn(outside.email).expect(200);
    expect(admitted.body.user).toMatchObject({
      principalKind: 'learner',
      managementSurfaceEnforced: false,
    });

    // The controller boundary agrees with the sign-in decision.
    const insideDenied = await request(app.getHttpServer())
      .get('/subdomains/availability')
      .query({ subdomain: 'flag-listed-probe' })
      .set(inside.auth)
      .expect(403);
    expect(insideDenied.body.error.messageKey).toBe('errors.auth.managementSurfaceOnly');
    await request(app.getHttpServer())
      .get('/subdomains/availability')
      .query({ subdomain: 'flag-unlisted-probe' })
      .set({ Authorization: `Bearer ${admitted.body.accessToken as string}` })
      .expect(200);
  });

  // -------------------------------------------------------------------
  // every other principal, in every mode
  // -------------------------------------------------------------------

  it('never changes what a client owner, manager, instructor or platform owner can do', async () => {
    const w = await world('flag-staff');
    const platformOwner = await staffAccount('flag-staff-platform');
    await admin.user.update({
      where: { id: platformOwner.userId },
      data: { isPlatformOwner: true },
    });

    for (const mode of ['on', 'allowlist', 'off'] as const) {
      flag.value = { mode, academyIds: [w.academy.id] };

      // Staff keep their management session and their academy scope.
      await request(app.getHttpServer())
        .get(`/academies/${w.academy.id}/students`)
        .set(w.owner.auth)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/academies/${w.academy.id}/students`)
        .set(w.manager.auth)
        .expect(200);
      // The instructor keeps the scoped read the RBAC matrix gives them.
      await request(app.getHttpServer())
        .get(`/academies/${w.academy.id}/students`)
        .set(w.instructor.auth)
        .expect(200);
      // ...and is still refused the academy settings surface.
      await request(app.getHttpServer())
        .get(`/academies/${w.academy.id}`)
        .set(w.instructor.auth)
        .expect(403);
      // The manager is still refused the owner-only security policy (D8).
      await request(app.getHttpServer())
        .patch(`/academies/${w.academy.id}/registration-policy`)
        .set(w.manager.auth)
        .send({ registrationPolicy: 'invite' })
        .expect(403);
      // A platform owner still reaches the platform surface.
      await request(app.getHttpServer())
        .get('/platform-users')
        .set(platformOwner.auth)
        .expect(200);

      await flushRateLimitKeys();
      await managementSignIn(w.owner.email).expect(200);
      await flushRateLimitKeys();
      await managementSignIn(w.instructor.email).expect(200);
    }
  });

  it('rolls back cleanly: ON, then OFF, then ON again, with no residue', async () => {
    const w = await world('flag-rollback');
    const student = await learner('flag-rollback-student', w.academy.id);

    // ON — refused.
    await flushRateLimitKeys();
    await managementSignIn(student.email).expect(403);

    // OFF — admitted, and the session issued here is a real one.
    flag.value = { mode: 'off', academyIds: [] };
    await flushRateLimitKeys();
    const rolledBack = await managementSignIn(student.email).expect(200);
    const auth = { Authorization: `Bearer ${rolledBack.body.accessToken as string}` };
    await request(app.getHttpServer())
      .get('/subdomains/availability')
      .query({ subdomain: 'flag-rollback-probe' })
      .set(auth)
      .expect(200);

    // ON again — the refusal returns immediately, and the session minted
    // while the flag was off stops reaching management controllers. No
    // redeploy, no sign-out, no residue.
    flag.value = { mode: 'on', academyIds: [] };
    await request(app.getHttpServer())
      .get('/subdomains/availability')
      .query({ subdomain: 'flag-rollback-probe' })
      .set(auth)
      .expect(403);
    await flushRateLimitKeys();
    await managementSignIn(student.email).expect(403);
  });
});
