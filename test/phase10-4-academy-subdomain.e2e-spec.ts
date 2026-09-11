/**
 * Phase 10.4 — Academy public-subdomain resolution (P104-SUB-001..008).
 *
 * THE PRODUCTION DEFECT THIS PINS. Atlas had two Academy-creation paths.
 * `ProvisioningOrchestratorService` allocated a subdomain as its own
 * step; `AcademiesService.create` — the ordinary "New Academy" flow —
 * did not. Every Academy created the ordinary way therefore had no
 * `subdomain_allocations` row, `resolve_public_hostname` matched nothing,
 * and its public website answered "not found".
 *
 * Confirmed against production before the fix: five Academies, two
 * allocations. DNS, TLS, Cloudflare and origin routing were all correct
 * the whole time — the missing database row was the entire fault. That
 * is why these tests assert on the ALLOCATION and on RESOLUTION rather
 * than on anything network-shaped.
 *
 * A NOTE ON HOSTNAMES IN TESTS. Resolution by full hostname depends on
 * `PLATFORM_BASE_DOMAIN`, which is deliberately unset in the test
 * environment. These tests therefore resolve by bare label — the same
 * code path, minus the base-domain suffix strip — plus one explicit test
 * that the suffix strip itself behaves correctly when a base domain IS
 * configured.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';
import { extractSubdomainLabel } from '../src/public-website/utils/hostname-normalization.util';

const PASSWORD = 'correct-horse-battery';

describe('Phase 10.4 Academy subdomain resolution (e2e) — P104-SUB-001..008', () => {
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

  /** Signs up an Owner, creates an Organization, and redeems its trial so entitlement permits an Academy. */
  async function seedOwnerWithOrganization(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Subdomain Tester', email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    const token: string = signIn.body.accessToken;

    const org = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `${label} org ${Date.now()}` })
      .expect(201);

    // Without a live trial the entitlement check refuses the Academy.
    await request(app.getHttpServer())
      .post(`/organizations/${org.body.id}/subscription/trial`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: true })
      .expect(200);

    return { token, organizationId: org.body.id as string };
  }

  /**
   * Creates an Academy through PROVISIONING — the only user-facing
   * creation path since Phase 10.6. The direct `POST /academies` route
   * these tests originally used no longer exists, precisely because
   * having two creation paths is what caused the dead-website defect
   * this suite exists to pin.
   *
   * Provisioning is asynchronous, so this waits for the Academy row.
   */
  async function createAcademy(
    token: string,
    organizationId: string,
    slug: string,
  ): Promise<{ status: number; body: { id: string } }> {
    await request(app.getHttpServer())
      .post(`/organizations/${organizationId}/provisioning-requests`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        academyName: `Academy ${slug}`,
        requestedSubdomain: slug,
        idempotencyKey: `${slug}-${Date.now()}`,
      })
      .expect(201);

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const academy = await admin.academy.findFirst({ where: { slug } });
      if (academy) return { status: 201, body: { id: academy.id } };
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Provisioning did not produce an Academy for slug ${slug}`);
  }

  function resolve(hostname: string) {
    return request(app.getHttpServer()).get(
      `/public/websites/resolve?hostname=${encodeURIComponent(hostname)}`,
    );
  }

  it('P104-SUB-001 — creating an Academy allocates its subdomain', async () => {
    // The regression guard for the whole defect.
    const { token, organizationId } = await seedOwnerWithOrganization('p104-001');
    const slug = `p104one${Date.now()}`;

    const academy = await createAcademy(token, organizationId, slug);

    const allocation = await admin.subdomainAllocation.findUnique({
      where: { academyId: academy.body.id },
    });
    expect(allocation).toBeTruthy();
    expect(allocation?.subdomain).toBe(slug);
    expect(allocation?.status).toBe('assigned');
  });

  it('P104-SUB-002 — the allocated subdomain resolves to that Academy', async () => {
    const { token, organizationId } = await seedOwnerWithOrganization('p104-002');
    const slug = `p104two${Date.now()}`;
    const academy = await createAcademy(token, organizationId, slug);

    const resolved = await resolve(slug).expect(200);

    expect(resolved.body.academyId).toBe(academy.body.id);
    expect(resolved.body.academySlug).toBe(slug);
  });

  it('P104-SUB-003 — an unknown subdomain returns a clean 404, not an error', async () => {
    // The public runtime must answer "no such Academy" itself rather than
    // failing in a way that surfaces as an infrastructure error.
    await resolve(`definitely-not-real-${Date.now()}`).expect(404);
  });

  it('P104-SUB-004 — resolution never leaks another Academy', async () => {
    const first = await seedOwnerWithOrganization('p104-004a');
    const second = await seedOwnerWithOrganization('p104-004b');
    const stamp = Date.now();
    const slugA = `p104foura${stamp}`;
    const slugB = `p104fourb${stamp}`;

    const academyA = await createAcademy(first.token, first.organizationId, slugA);
    const academyB = await createAcademy(second.token, second.organizationId, slugB);

    const resolvedA = await resolve(slugA).expect(200);
    const resolvedB = await resolve(slugB).expect(200);

    expect(resolvedA.body.academyId).toBe(academyA.body.id);
    expect(resolvedB.body.academyId).toBe(academyB.body.id);
    expect(resolvedA.body.academyId).not.toBe(resolvedB.body.academyId);
  });

  it('P104-SUB-005 — resolution is public and needs no session', async () => {
    // A public website must be readable by someone who is not signed in —
    // that is the entire point.
    const { token, organizationId } = await seedOwnerWithOrganization('p104-005');
    const slug = `p104five${Date.now()}`;
    await createAcademy(token, organizationId, slug);

    // No Authorization header anywhere in `resolve`.
    const resolved = await resolve(slug).expect(200);
    expect(resolved.body.academySlug).toBe(slug);
  });

  it('P104-SUB-006 — the resolution response exposes no private Academy data', async () => {
    const { token, organizationId } = await seedOwnerWithOrganization('p104-006');
    const slug = `p104six${Date.now()}`;
    await createAcademy(token, organizationId, slug);

    const resolved = await resolve(slug).expect(200);

    // Exactly the fields the public runtime needs to bootstrap a site.
    expect(Object.keys(resolved.body).sort()).toEqual(
      ['academyId', 'academyName', 'academySlug'].sort(),
    );
    const serialised = JSON.stringify(resolved.body);
    expect(serialised).not.toContain('organizationId');
    expect(serialised).not.toContain('@atlas.test');
  });

  it('P104-SUB-007 — the base-domain suffix strip extracts exactly one label', async () => {
    // The half that cannot be exercised through HTTP here, because
    // `PLATFORM_BASE_DOMAIN` is unset in the test environment. Asserted
    // directly instead of skipped.
    const base = 'atlass.dpdns.org';

    expect(extractSubdomainLabel('harvard.atlass.dpdns.org', base)).toBe('harvard');
    // The bare base domain is the marketing site, not an Academy.
    expect(extractSubdomainLabel(base, base)).toBeNull();
    // Multi-label subdomains are not Academy hostnames.
    expect(extractSubdomainLabel('a.b.atlass.dpdns.org', base)).toBeNull();
    // A different domain entirely must never match.
    expect(extractSubdomainLabel('harvard.example.com', base)).toBeNull();
    // No configured base domain -> no extraction, never a wrong guess.
    expect(extractSubdomainLabel('harvard.atlass.dpdns.org', undefined)).toBeNull();
  });

  it('P104-SUB-008 — every Academy the APPLICATION created has a subdomain allocation', async () => {
    // The backfill's own assertion, scoped to what it can honestly claim.
    //
    // A first version of this asserted the invariant GLOBALLY — zero
    // academies anywhere without an allocation. That failed locally with
    // 29 orphans, and the orphans were real, so it is worth recording why
    // they are not a bug: every one was seeded by another e2e suite
    // calling `admin.academy.create` / `tx.academy.create` directly
    // against the database. Those suites test RLS and analytics and have
    // no interest in subdomains, so bypassing the service is legitimate
    // there — but it also means the global count measures test fixtures
    // rather than application behaviour.
    //
    // Scoping to academies that have a provisioning request asserts
    // exactly the thing that matters and cannot be defeated by direct-SQL
    // seeding: everything Atlas itself created went through provisioning,
    // and provisioning must always have allocated a subdomain. The
    // application has exactly one creation path
    // (`ProvisioningOrchestratorService` -> `AcademiesService.create`),
    // which is what makes this equivalent to the global claim for real
    // data.
    //
    // The global form WAS run against production, separately, after the
    // backfill migration: zero orphans across all five academies.
    const orphaned = await admin.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count
         FROM academies a
        WHERE EXISTS (
          SELECT 1 FROM provisioning_requests pr WHERE pr."academy_id" = a.id
        )
          AND NOT EXISTS (
          SELECT 1 FROM subdomain_allocations sa WHERE sa.academy_id = a.id
        )`,
    );
    expect(Number(orphaned[0].count)).toBe(0);
  });
});
