/**
 * P63 — Domain, subdomain & website access: real-PostgreSQL e2e.
 *
 * Runs the real `AppModule` (real guards, real RLS, real transactions,
 * real audit writer) with ONE substitution: `CLOUDFLARE_PROVIDER` is the
 * stateful `FakeCloudflareProvider`, because the genuine adapter has no
 * credentials here and could only ever say "not connected". Every
 * assertion below is about what Atlas does with what the provider says —
 * never about the provider itself.
 *
 * P63-DOM-001..0xx: customer lifecycle, idempotency, concurrency,
 * truthfulness, canonical host, audit.
 * P63-OPS-001..0xx: Platform Owner operations, readiness, authorization.
 * P63-SWP-001..00x: the verification sweep.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import type { PlatformDomainRuntimeConfig } from '../src/config/configuration';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { FakeCloudflareProvider } from './utils/fake-cloudflare-provider';
import { FakeHttpsProbe } from './utils/fake-https-probe';
import { HttpsProbeService } from '../src/domain/services/https-probe.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { DomainConnectionsRepository } from '../src/domain/repositories/domain-connections.repository';
import { CLOUDFLARE_PROVIDER } from '../src/domain/providers/cloudflare-provider.interface';
import { DomainVerificationSweepService } from '../src/domain/services/domain-verification-sweep.service';
import { PlatformDomainService } from '../src/domain/services/platform-domain.service';
import { AcademiesService } from '../src/academy/services/academies.service';

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

describe('P63 — domain operations (e2e, real PostgreSQL, fake provider)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  const cloudflare = new FakeCloudflareProvider();
  const probe = new FakeHttpsProbe();
  const run = Date.now();
  /** `PLATFORM_BASE_DOMAIN` may or may not be set where this runs (CI: unset; a developer's `.env` may set it). Every expectation about "the Atlas subdomain host" is phrased for both. */
  let envBaseDomain: string | undefined;
  const subdomainHostFor = (slug: string) =>
    envBaseDomain ? { host: `${slug}.${envBaseDomain}`, source: 'subdomain' } : undefined;

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(CLOUDFLARE_PROVIDER)
          .useValue(cloudflare)
          .overrideProvider(HttpsProbeService)
          .useValue(probe),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    envBaseDomain = app
      .get(ConfigService)
      .get<PlatformDomainRuntimeConfig>('platformDomain')
      ?.baseDomain?.toLowerCase();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
    cloudflare.reset();
    probe.reset();
    app.get(PlatformDomainService, { strict: false }).invalidateZoneFacts();
  });

  async function seedManagedAcademy(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { owner, org, academy };
  }

  /** The application always allocates `subdomain = slug` when it creates an Academy (P104-SUB-008); `seedAcademy` does not, so tests about the Atlas address seed the same row. */
  async function seedManagedAcademyWithSubdomain(label: string) {
    const seeded = await seedManagedAcademy(label);
    await admin.subdomainAllocation.create({
      data: {
        academyId: seeded.academy.id,
        subdomain: seeded.academy.slug,
        status: 'assigned',
        fullHost: envBaseDomain ? `${seeded.academy.slug}.${envBaseDomain}` : null,
      },
    });
    return seeded;
  }

  async function seedPlatformOwner(label: string) {
    const user = await signUpAndSignIn(app, label);
    await admin.user.update({
      where: { id: user.userId },
      data: { isPlatformOwner: true },
    });
    return user;
  }

  const domainPath = (academyId: string, ...rest: string[]) =>
    ['/academies', academyId, 'website', 'domain', ...rest].join('/');

  function addDomain(academyId: string, token: string, hostname: string) {
    return request(app.getHttpServer())
      .post(domainPath(academyId, 'custom-domain'))
      .set('Authorization', `Bearer ${token}`)
      .send({ hostname });
  }
  function verify(academyId: string, token: string) {
    return request(app.getHttpServer())
      .post(domainPath(academyId, 'verify'))
      .set('Authorization', `Bearer ${token}`);
  }

  // ---------------------------------------------------------------- customer

  it('P63-DOM-001 — adding a domain registers it with the provider, stores its records, the CNAME target and provider id, and audits it', async () => {
    const { owner, academy, org } = await seedManagedAcademy('p63-add');
    const hostname = `learn-${run}-001.example.com`;

    const added = await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    expect(added.body.customDomain).toMatchObject({
      hostname,
      status: 'verifying', // the fake provider answers `pending` → mapped `verifying`
    });
    expect(added.body.dns.cnameTarget).toBe('customers.atlas-test.dev');
    expect(added.body.dns.records.length).toBeGreaterThanOrEqual(2);
    expect(added.body.customDomain.lastCheckedAt).toEqual(expect.any(String));
    expect(added.body.customDomain.lastCheckError).toBeUndefined();
    expect(cloudflare.has(hostname)).toBe(true);

    const row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(row.providerHostnameId).toMatch(/^cfh_/);
    expect(row.cdnProvider).toBe('cloudflare');

    const audit = await admin.auditLogEntry.findMany({
      where: { action: 'domain.custom_domain_added', targetId: row.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorUserId: owner.userId,
      organizationId: org.id,
      academyId: academy.id,
      targetLabel: hostname,
    });
    expect(
      (audit[0].changes as Record<string, { from: unknown; to: unknown }>).hostname,
    ).toEqual({
      from: null,
      to: hostname,
    });
  });

  it('P63-DOM-002 — re-submitting the same hostname is idempotent: one provider resource, records kept, no second registration', async () => {
    const { owner, academy } = await seedManagedAcademy('p63-idem');
    const hostname = `learn-${run}-002.example.com`;
    const first = await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    const firstRow = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });

    const second = await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    const secondRow = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });

    expect(secondRow.id).toBe(firstRow.id);
    expect(secondRow.providerHostnameId).toBe(firstRow.providerHostnameId);
    expect(second.body.dns.records).toEqual(first.body.dns.records);
    // The resubmission keeps the provider id, so the check looks it up by id: exactly one registration ever.
    expect(cloudflare.calls.filter((c) => c === `create:${hostname}`)).toHaveLength(1);
    expect(cloudflare.calls.filter((c) => c.startsWith('delete:'))).toHaveLength(0);
  });

  it('P63-DOM-003 — changing hostname releases the previous provider resource and audits the replacement', async () => {
    const { owner, academy } = await seedManagedAcademy('p63-replace');
    const first = `learn-${run}-003a.example.com`;
    const second = `learn-${run}-003b.example.com`;
    await addDomain(academy.id, owner.accessToken, first).expect(201);
    await addDomain(academy.id, owner.accessToken, second).expect(201);

    expect(cloudflare.has(first)).toBe(false);
    expect(cloudflare.has(second)).toBe(true);
    const row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(row.hostname).toBe(second);
    const audit = await admin.auditLogEntry.findMany({
      where: { action: 'domain.custom_domain_added', targetId: row.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit).toHaveLength(2);
    expect((audit[1].context as Record<string, unknown>).replacedHostname).toBe(first);
  });

  it('P63-DOM-004 — two organizations claiming the same hostname concurrently: exactly one wins, the other gets 409, no raw 500', async () => {
    const a = await seedManagedAcademy('p63-race-a');
    const b = await seedManagedAcademy('p63-race-b');
    const hostname = `learn-${run}-004.example.com`;

    const [ra, rb] = await Promise.all([
      addDomain(a.academy.id, a.owner.accessToken, hostname),
      addDomain(b.academy.id, b.owner.accessToken, hostname),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(loser.body.error.messageKey).toBe('errors.domain.hostnameTaken');

    const holders = await admin.domainConnection.findMany({ where: { hostname } });
    expect(holders).toHaveLength(1);
  });

  it('P63-DOM-005 — a hostname another Academy already holds is refused (409), and the holder is untouched', async () => {
    const holder = await seedManagedAcademy('p63-held-a');
    const other = await seedManagedAcademy('p63-held-b');
    const hostname = `learn-${run}-005.example.com`;
    await addDomain(holder.academy.id, holder.owner.accessToken, hostname).expect(201);
    const refused = await addDomain(
      other.academy.id,
      other.owner.accessToken,
      hostname,
    ).expect(409);
    expect(refused.body.error.messageKey).toBe('errors.domain.hostnameTaken');
    const row = await admin.domainConnection.findUniqueOrThrow({ where: { hostname } });
    expect(row.academyId).toBe(holder.academy.id);
  });

  it('P63-DOM-006 — verification is server-authoritative: only the provider moving to active makes the domain connected, and that is when the HTTPS probe runs', async () => {
    const { owner, academy } = await seedManagedAcademyWithSubdomain('p63-verify');
    const hostname = `learn-${run}-006.example.com`;
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);

    // Still pending at the provider: a check records the attempt, no more.
    const stillPending = await verify(academy.id, owner.accessToken).expect(201);
    expect(stillPending.body.customDomain.status).toBe('verifying');
    expect(stillPending.body.customDomain.connectedAt).toBeUndefined();
    expect(stillPending.body.customDomain.httpsReachable).toBeUndefined();
    // Not connected yet: the Atlas subdomain (when a base domain exists) is canonical, never the pending custom domain.
    expect(stillPending.body.canonicalHost).toEqual(subdomainHostFor(academy.slug));

    cloudflare.setState(hostname, 'active', 'active');
    const connected = await verify(academy.id, owner.accessToken).expect(201);
    expect(connected.body.customDomain).toMatchObject({ status: 'connected' });
    expect(connected.body.customDomain.connectedAt).toEqual(expect.any(String));
    expect(connected.body.ssl.status).toBe('active');
    expect(connected.body.cdn.status).toBe('active');
    // The HTTPS probe ran exactly when the provider said "live", not before.
    expect(probe.probed).toEqual([hostname]);
    expect(connected.body.customDomain.httpsReachable).toBe(true);
    expect(connected.body.customDomain.httpsCheckedAt).toEqual(expect.any(String));
    expect(connected.body.customDomain).toMatchObject({
      sslStatus: 'active',
      live: true,
      httpsStatusCode: 200,
    });
    expect(connected.body.canonicalHost).toEqual({
      host: hostname,
      source: 'custom_domain',
    });

    // connectedAt is preserved across further successful checks.
    const again = await verify(academy.id, owner.accessToken).expect(201);
    expect(again.body.customDomain.connectedAt).toBe(
      connected.body.customDomain.connectedAt,
    );

    const audit = await admin.auditLogEntry.findMany({
      where: { action: 'domain.verification_checked', academyId: academy.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(audit.length).toBeGreaterThanOrEqual(3);
    const transition = audit.find(
      (entry) =>
        (entry.changes as Record<string, { from: unknown; to: unknown }>).status.to ===
          'connected' &&
        (entry.changes as Record<string, { from: unknown; to: unknown }>).status.from !==
          'connected',
    );
    expect(transition).toBeDefined();
  });

  it('P63-DOM-007 — the provider explaining that DNS is not pointing at Atlas yet becomes an actionable, non-sensitive error code', async () => {
    const { owner, academy } = await seedManagedAcademy('p63-dns');
    const hostname = `learn-${run}-007.example.com`;
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    cloudflare.setState(hostname, 'pending', 'pending_validation', [
      'The custom hostname CNAME does not point to the SaaS zone (secret-token-xyz).',
    ]);
    const checked = await verify(academy.id, owner.accessToken).expect(201);
    expect(checked.body.customDomain.lastCheckError).toBe('dns_not_pointing');
    expect(JSON.stringify(checked.body)).not.toContain('secret-token-xyz');
  });

  it('P63-DOM-008 — a provider outage is recorded as provider_error and changes no status; a vanished hostname is re-registered by the next check', async () => {
    const { owner, academy } = await seedManagedAcademy('p63-outage');
    const hostname = `learn-${run}-008.example.com`;
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    cloudflare.setState(hostname, 'active', 'active');
    await verify(academy.id, owner.accessToken).expect(201);

    cloudflare.outage = true;
    const duringOutage = await verify(academy.id, owner.accessToken).expect(201);
    expect(duringOutage.body.customDomain.status).toBe('connected');
    expect(duringOutage.body.customDomain.lastCheckError).toBe('provider_error');
    cloudflare.outage = false;

    // P63g — a hostname the provider positively lost is REGISTERED AFRESH
    // by the next check (self-healing), never reported "missing" forever.
    cloudflare.forget(hostname);
    const gone = await verify(academy.id, owner.accessToken).expect(201);
    expect(cloudflare.has(hostname)).toBe(true);
    expect(gone.body.customDomain.status).toBe('verifying');
    expect(gone.body.customDomain.lastCheckError).toBeUndefined();
    expect(gone.body.customDomain.connectedAt).toBeUndefined();
    expect(gone.body.customDomain.providerRegistered).toBe(true);
    expect(gone.body.dns.ready).toBe(true);
    const audit = await admin.auditLogEntry.findFirst({
      where: { action: 'domain.verification_checked', academyId: academy.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect((audit?.context as Record<string, unknown>).reRegistered).toBe(true);
  });

  it('P63-DOM-009 — with no provider credentials the row records provider_unavailable and stands exactly as it was — never a simulated success', async () => {
    const { owner, academy } = await seedManagedAcademy('p63-nocreds');
    const hostname = `learn-${run}-009.example.com`;
    cloudflare.connected = false;
    const added = await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    expect(added.body.customDomain.status).toBe('verification_required');
    expect(added.body.customDomain.lastCheckError).toBe('provider_unavailable');
    expect(added.body.customDomain.providerRegistered).toBe(false);
    expect(added.body.dns).toMatchObject({
      ready: false,
      blockedReason: 'provider_not_registered',
      records: [],
    });
    expect(added.body.dns.cnameTarget).toBe('customers.atlas-test.dev'); // the fake still answers the zone question
    const checked = await verify(academy.id, owner.accessToken).expect(201);
    expect(checked.body.customDomain.status).toBe('verification_required');
    expect(checked.body.customDomain.lastCheckError).toBe('provider_unavailable');
  });

  it('P63-DOM-010 — overlapping checks on one Academy serialize on the row lock and end in one consistent state', async () => {
    const { owner, academy } = await seedManagedAcademy('p63-overlap');
    const hostname = `learn-${run}-010.example.com`;
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    cloudflare.setState(hostname, 'active', 'active');

    const results = await Promise.all(
      Array.from({ length: 4 }, () => verify(academy.id, owner.accessToken)),
    );
    for (const result of results) expect(result.status).toBe(201);
    const row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(row.status).toBe('connected');
    expect(row.connectedAt).not.toBeNull();
    const connectedAts = new Set(results.map((r) => r.body.customDomain.connectedAt));
    expect(connectedAts.size).toBe(1); // the first to lock set it; the rest preserved it
    const audit = await admin.auditLogEntry.count({
      where: { action: 'domain.verification_checked', academyId: academy.id },
    });
    expect(audit).toBe(4);
  });

  it('P63-DOM-011 — disconnecting releases the provider resource, resets the row (never deletes it), clears check state, and audits', async () => {
    const { owner, academy } = await seedManagedAcademy('p63-remove');
    const hostname = `learn-${run}-011.example.com`;
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    const removed = await request(app.getHttpServer())
      .delete(domainPath(academy.id, 'custom-domain'))
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(removed.body.customDomain).toBeUndefined();
    expect(removed.body.dns).toBeUndefined();
    expect(cloudflare.has(hostname)).toBe(false);
    const row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(row).toMatchObject({
      hostname: null,
      status: 'not_configured',
      providerHostnameId: null,
      lastCheckedAt: null,
      lastCheckError: null,
    });
    const audit = await admin.auditLogEntry.findMany({
      where: { action: 'domain.custom_domain_removed', targetId: row.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].targetLabel).toBe(hostname);
    // Removing again is a safe no-op: no second audit row, no error.
    await request(app.getHttpServer())
      .delete(domainPath(academy.id, 'custom-domain'))
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(
      await admin.auditLogEntry.count({
        where: { action: 'domain.custom_domain_removed', targetId: row.id },
      }),
    ).toBe(1);
  });

  it('P63-DOM-012 — the public runtime resolves a connected custom domain and advertises it as canonical; an unverified one resolves nothing', async () => {
    const { owner, academy } = await seedManagedAcademy('p63-public');
    const hostname = `learn-${run}-012.example.com`;
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    await request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname })
      .expect(404);

    cloudflare.setState(hostname, 'active', 'active');
    await verify(academy.id, owner.accessToken).expect(201);
    const resolved = await request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname })
      .expect(200);
    expect(resolved.body).toMatchObject({
      academyId: academy.id,
      canonicalHost: hostname,
    });
    expect(resolved.body).not.toHaveProperty('organizationId');
  });

  it("P63-DOM-013 — a Manager of a different Academy in the same Organization can neither read nor check this Academy's domain", async () => {
    const { owner, org, academy } = await seedManagedAcademy('p63-scope');
    const hostname = `learn-${run}-013.example.com`;
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    const manager = await signUpAndSignIn(app, 'p63-scope-manager');
    await admin.organizationMembership.create({
      data: {
        organizationId: org.id,
        userId: manager.userId,
        role: 'manager',
        isPrimary: false,
      },
    });
    const otherAcademy = await seedAcademy(admin, org.id, 'p63-scope-other');
    await seedAcademyMember(admin, otherAcademy.id, manager.userId, 'manager');

    await request(app.getHttpServer())
      .get(domainPath(academy.id))
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(403);
    await verify(academy.id, manager.accessToken).expect(403);
    await request(app.getHttpServer())
      .delete(domainPath(academy.id, 'custom-domain'))
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .expect(403);
    expect(cloudflare.has(hostname)).toBe(true);
  });

  it('P63-DOM-014 — an IP literal is refused at the door (400): never registered with the provider, never probed', async () => {
    const { owner, academy } = await seedManagedAcademy('p63-ip');
    for (const hostname of ['127.0.0.1', '169.254.169.254', '10.0.0.5']) {
      const refused = await addDomain(academy.id, owner.accessToken, hostname).expect(
        400,
      );
      expect(JSON.stringify(refused.body)).toContain('invalidHostname');
      expect(cloudflare.has(hostname)).toBe(false);
    }
    expect(probe.probed).toEqual([]);
  });

  it('P63-DOM-015 — a connected custom domain that stops answering over HTTPS is demoted: the Atlas subdomain becomes canonical again (public runtime included), while the custom hostname itself still resolves', async () => {
    const { owner, academy } = await seedManagedAcademyWithSubdomain('p63-demote');
    const hostname = `learn-${run}-015.example.com`;
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    cloudflare.setState(hostname, 'active', 'active');
    const live = await verify(academy.id, owner.accessToken).expect(201);
    expect(live.body.canonicalHost).toEqual({ host: hostname, source: 'custom_domain' });
    const resolvedLive = await request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname })
      .expect(200);
    expect(resolvedLive.body.canonicalHost).toBe(hostname);

    probe.setReachable(hostname, false);
    const demoted = await verify(academy.id, owner.accessToken).expect(201);
    expect(demoted.body.customDomain).toMatchObject({
      status: 'connected',
      httpsReachable: false,
      httpsFailureReason: 'tls_or_connection_failed',
      live: false,
    });
    // Back to the Atlas subdomain (or honestly no host when no base domain exists) — never the dead custom one.
    expect(demoted.body.canonicalHost).toEqual(subdomainHostFor(academy.slug));
    const resolvedDemoted = await request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname })
      .expect(200);
    expect(resolvedDemoted.body.academyId).toBe(academy.id);
    expect(resolvedDemoted.body.canonicalHost).toBe(subdomainHostFor(academy.slug)?.host);
  });

  describe('RLS independently agrees (direct, no guards)', () => {
    it('P63-RLS-001 — a non-owner user context sees zero rows from the operations query and cannot UPDATE through the platform policy; a platform owner context can', async () => {
      const tenancy = app.get(TenancyContextService, { strict: false });
      const repository = app.get(DomainConnectionsRepository, { strict: false });
      const tenant = await seedManagedAcademy('p63-rls');
      const hostname = `rls-${run}.example.com`;
      await addDomain(tenant.academy.id, tenant.owner.accessToken, hostname).expect(201);
      const outsider = await signUpAndSignIn(app, 'p63-rls-outsider');
      const platformOwner = await seedPlatformOwner('p63-rls-owner');

      const asOutsider = await tenancy.runInUserContext(outsider.userId, (tx) =>
        repository.findManyAcademiesWithDomains(tx, {
          search: hostname,
          skip: 0,
          take: 10,
        }),
      );
      expect(asOutsider.totalItems).toBe(0);

      const outsiderUpdate = await tenancy.runInUserContext(outsider.userId, (tx) =>
        tx.domainConnection.updateMany({
          where: { hostname },
          data: { lastCheckError: 'provider_error' },
        }),
      );
      expect(outsiderUpdate.count).toBe(0);

      // The row's own owner, with only the user variable set (no organization), also sees nothing.
      const ownerWithoutOrg = await tenancy.runInUserContext(tenant.owner.userId, (tx) =>
        repository.findManyAcademiesWithDomains(tx, {
          search: hostname,
          skip: 0,
          take: 10,
        }),
      );
      expect(ownerWithoutOrg.totalItems).toBe(0);

      const asPlatform = await tenancy.runInUserContext(platformOwner.userId, (tx) =>
        repository.findManyAcademiesWithDomains(tx, {
          search: hostname,
          skip: 0,
          take: 10,
        }),
      );
      expect(asPlatform.totalItems).toBe(1);
      const platformUpdate = await tenancy.runInUserContext(platformOwner.userId, (tx) =>
        tx.domainConnection.updateMany({
          where: { hostname },
          data: { lastCheckError: 'provider_error' },
        }),
      );
      expect(platformUpdate.count).toBe(1);

      // But the platform context still cannot INSERT a customer's domain row.
      const other = await seedManagedAcademy('p63-rls-other');
      await expect(
        tenancy.runInUserContext(platformOwner.userId, (tx) =>
          tx.domainConnection.create({
            data: {
              academyId: other.academy.id,
              hostname: `rls-insert-${run}.example.com`,
              status: 'connected',
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('P63-DOM-016 — the rawc.ae case: the provider REFUSES registration; the row records the refusal with its code, DNS is honestly not ready, and a later check retries registration instead of calling the hostname "missing"', async () => {
    const { owner, academy } = await seedManagedAcademy('p63-refused');
    const hostname = `learn-${run}-016.example.com`;
    cloudflare.registrationRefusal = { code: 10000, category: 'permission' };

    const added = await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    expect(added.body.customDomain).toMatchObject({
      status: 'verification_required',
      lastCheckError: 'provider_registration_failed',
      providerRegistered: false,
      providerErrorCode: '10000',
    });
    expect(added.body.dns).toMatchObject({
      ready: false,
      blockedReason: 'provider_not_registered',
      records: [],
    });
    expect(cloudflare.has(hostname)).toBe(false);
    expect(JSON.stringify(added.body)).not.toMatch(/token|secret|Authentication/i);

    // Still refused: the same honest state, never "no longer has a record".
    const stillRefused = await verify(academy.id, owner.accessToken).expect(201);
    expect(stillRefused.body.customDomain.lastCheckError).toBe(
      'provider_registration_failed',
    );
    expect(stillRefused.body.customDomain.providerRegistered).toBe(false);

    // The provider configuration gets fixed: the very next check registers and moves on.
    cloudflare.registrationRefusal = null;
    const recovered = await verify(academy.id, owner.accessToken).expect(201);
    expect(recovered.body.customDomain).toMatchObject({
      status: 'verifying',
      providerRegistered: true,
    });
    expect(recovered.body.customDomain.lastCheckError).toBeUndefined();
    expect(recovered.body.customDomain.providerErrorCode).toBeUndefined();
    expect(recovered.body.dns.ready).toBe(true);
    expect(recovered.body.dns.records.length).toBeGreaterThanOrEqual(2);
    expect(cloudflare.calls.filter((c) => c === `create:${hostname}`)).toHaveLength(3);
    expect(cloudflare.has(hostname)).toBe(true);
    const row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(row.providerHostnameId).toMatch(/^cfh_/);
    expect(row.lastProviderErrorCode).toBeNull();
  });

  it('P63-DOM-017 — "no CNAME target" is reported as a routing blocker, not as something the customer must fix', async () => {
    const { owner, academy } = await seedManagedAcademy('p63-noroute');
    const hostname = `learn-${run}-017.example.com`;
    cloudflare.fallbackOrigin = null;
    app.get(PlatformDomainService, { strict: false }).invalidateZoneFacts();
    const added = await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    expect(added.body.customDomain.providerRegistered).toBe(true);
    expect(added.body.dns).toMatchObject({
      ready: false,
      blockedReason: 'routing_target_missing',
    });
    expect(added.body.dns.cnameTarget).toBeUndefined();
    expect(added.body.dns.records.length).toBeGreaterThanOrEqual(2);
  });

  it('P63-DOM-018 — the sweep retries a refused registration and succeeds once the provider allows it', async () => {
    const sweep = app.get(DomainVerificationSweepService, { strict: false });
    const { owner, academy } = await seedManagedAcademy('p63-refused-sweep');
    const hostname = `learn-${run}-018.example.com`;
    cloudflare.registrationRefusal = { code: 10000, category: 'permission' };
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    // Oldest-first: the shared dev database holds hundreds of stale rows
    // from earlier runs, and the sweep caps each tick at 200 — an ancient
    // timestamp puts this row at the head of the queue instead of behind them.
    await admin.domainConnection.update({
      where: { academyId: academy.id },
      data: { lastCheckedAt: new Date('2000-01-01T00:00:00Z') },
    });
    cloudflare.registrationRefusal = null;
    await sweep.run();
    const row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(row.providerHostnameId).toMatch(/^cfh_/);
    expect(row.status).toBe('verifying');
    expect(row.lastCheckError).toBeNull();
  });

  it('P63-DOM-019 — changing a wrongly entered pending domain: the old provider resource is released, no duplicate row, the new hostname starts clean; a resubmission of the same hostname changes nothing', async () => {
    const { owner, academy } = await seedManagedAcademy('p63-change');
    const wrong = `learn-${run}-019-wrong.example.com`;
    const right = `learn-${run}-019-right.example.com`;
    await addDomain(academy.id, owner.accessToken, wrong).expect(201);
    const changed = await addDomain(academy.id, owner.accessToken, right).expect(201);
    expect(changed.body.customDomain.hostname).toBe(right);
    expect(changed.body.customDomain.providerRegistered).toBe(true);
    expect(cloudflare.has(wrong)).toBe(false);
    expect(cloudflare.has(right)).toBe(true);
    expect(await admin.domainConnection.count({ where: { academyId: academy.id } })).toBe(
      1,
    );
    expect(await admin.domainConnection.count({ where: { hostname: wrong } })).toBe(0);
    const before = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    const same = await addDomain(academy.id, owner.accessToken, right).expect(201);
    expect(same.body.customDomain.hostname).toBe(right);
    const after = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(after.providerHostnameId).toBe(before.providerHostnameId);
    expect(cloudflare.calls.filter((c) => c.startsWith('delete:'))).toHaveLength(1);
  });

  // --------------------------------------------------------- platform owner

  it('P63-DOM-020 — the rawc.ae 525 case: the provider says active, the certificate is still pending and the edge answers 525 — the domain is connected but NOT live, the Atlas subdomain stays canonical, and the reason is recorded', async () => {
    const { owner, academy } = await seedManagedAcademyWithSubdomain('p63-525');
    const hostname = `learn-${run}-020.example.com`;
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);

    // Hostname active at the edge, certificate not yet issued, visitors get 525.
    cloudflare.setState(hostname, 'active', 'pending_validation');
    probe.setEdgeStatus(hostname, 525);
    const connected = await verify(academy.id, owner.accessToken).expect(201);
    expect(connected.body.customDomain).toMatchObject({
      status: 'connected',
      sslStatus: 'pending',
      httpsReachable: false,
      httpsStatusCode: 525,
      httpsFailureReason: 'origin_error',
      live: false,
    });
    expect(connected.body.ssl.status).toBe('pending');
    // A dead custom domain is never advertised: the Atlas subdomain stays canonical.
    expect(connected.body.canonicalHost).toEqual(subdomainHostFor(academy.slug));

    // Certificate issued, but the origin path still broken: still not live.
    cloudflare.setState(hostname, 'active', 'active');
    const certOnly = await verify(academy.id, owner.accessToken).expect(201);
    expect(certOnly.body.customDomain).toMatchObject({
      sslStatus: 'active',
      httpsReachable: false,
      httpsStatusCode: 525,
      live: false,
    });

    // Origin fixed: the edge answers 200 — now, and only now, live.
    probe.setEdgeStatus(hostname, 200);
    const live = await verify(academy.id, owner.accessToken).expect(201);
    expect(live.body.customDomain).toMatchObject({
      status: 'connected',
      sslStatus: 'active',
      httpsReachable: true,
      httpsStatusCode: 200,
      live: true,
    });
    expect(live.body.customDomain.httpsFailureReason).toBeUndefined();
    expect(live.body.canonicalHost).toEqual({ host: hostname, source: 'custom_domain' });

    // The Platform Owner sees the same truth on the row and in the overview.
    const platformOwner = await seedPlatformOwner('p63-525-owner');
    const row = await request(app.getHttpServer())
      .get(`/platform-domains/${academy.id}`)
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .expect(200);
    expect(row.body.customDomain).toMatchObject({ live: true, sslStatus: 'active' });
    const overview = await request(app.getHttpServer())
      .get('/platform-domains/overview')
      .set('Authorization', `Bearer ${platformOwner.accessToken}`)
      .expect(200);
    expect(overview.body.customLive).toBeGreaterThanOrEqual(1);
    expect(overview.body.customLive).toBeLessThanOrEqual(overview.body.customConnected);
  });

  it('P63-DOM-021 — a connected domain that answers over HTTPS is live even while the provider certificate is pending, stays on the fast sweep cadence until the certificate is active, then moves to the slow cadence', async () => {
    const { owner, academy } = await seedManagedAcademyWithSubdomain('p63-sslpending');
    const hostname = `learn-${run}-021.example.com`;
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    cloudflare.setState(hostname, 'active', 'pending_issuance');
    // The edge already answers with a trusted certificate (the rawc.ae case:
    // the customer's own Cloudflare zone terminates TLS) — visitors have a
    // working site, so it IS live, while the provider's own certificate is
    // still pending and reported as such.
    const connected = await verify(academy.id, owner.accessToken).expect(201);
    expect(connected.body.customDomain).toMatchObject({
      status: 'connected',
      sslStatus: 'provisioning',
      httpsReachable: true,
      live: true,
    });
    expect(connected.body.canonicalHost).toEqual({
      host: hostname,
      source: 'custom_domain',
    });

    // Six minutes later the sweep picks it up on the FAST cadence (not the six-hour one).
    await admin.domainConnection.update({
      where: { academyId: academy.id },
      data: { lastCheckedAt: new Date(Date.now() - 6 * 60 * 1000) },
    });
    cloudflare.setState(hostname, 'active', 'active');
    const sweep = app.get(DomainVerificationSweepService, { strict: false });
    const result = await sweep.run();
    expect(result.skipped).toBeNull();
    const row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(row.sslStatus).toBe('active');
    expect(row.httpsReachable).toBe(true);
    const nowLive = await request(app.getHttpServer())
      .get(domainPath(academy.id))
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(nowLive.body.customDomain.live).toBe(true);

    // Settled (live AND certificate active): the slow cadence — the sweep leaves it alone.
    await admin.domainConnection.update({
      where: { academyId: academy.id },
      data: { lastCheckedAt: new Date(Date.now() - 6 * 60 * 1000) },
    });
    const before = (
      await admin.domainConnection.findUniqueOrThrow({ where: { academyId: academy.id } })
    ).updatedAt;
    await sweep.run();
    const after = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(after.updatedAt).toEqual(before);
  });

  it('P63-DOM-022 — the rawc.ae DNS-removal case: a live domain whose CNAME stops pointing at Atlas becomes failed with the CNAME instruction still shown (even with no provider records), the sweep keeps re-checking it, and it comes back on its own once DNS is restored', async () => {
    const { owner, academy } = await seedManagedAcademyWithSubdomain('p63-dns-removed');
    const hostname = `learn-${run}-022.example.com`;
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    cloudflare.setState(hostname, 'active', 'active');
    cloudflare.withholdRecords(hostname);
    const live = await verify(academy.id, owner.accessToken).expect(201);
    expect(live.body.customDomain).toMatchObject({ status: 'connected', live: true });
    // Verified and issued: no provider records any more — the CNAME is still
    // the customer's to keep, so the instructions stay ready.
    expect(live.body.customDomain.verificationRecords).toBeUndefined();
    expect(live.body.dns).toMatchObject({
      ready: true,
      cnameTarget: 'customers.atlas-test.dev',
      records: [],
    });

    // The customer deletes the CNAME: the provider marks the hostname moved.
    cloudflare.setState(hostname, 'moved', 'active', [
      'The CNAME record for this hostname does not point to the zone',
    ]);
    const broken = await verify(academy.id, owner.accessToken).expect(201);
    expect(broken.body.customDomain).toMatchObject({
      status: 'failed',
      lastCheckError: 'dns_not_pointing',
      live: false,
    });
    expect(broken.body.dns).toMatchObject({
      ready: true,
      cnameTarget: 'customers.atlas-test.dev',
    });
    expect(broken.body.canonicalHost).toEqual(subdomainHostFor(academy.slug));

    // The customer restores DNS; nobody clicks. Six minutes later the sweep
    // re-checks the FAILED row (P63f) and the provider says active again.
    await admin.domainConnection.update({
      where: { academyId: academy.id },
      data: { lastCheckedAt: new Date('2000-01-01T00:00:00Z') },
    });
    cloudflare.setState(hostname, 'active', 'active');
    const sweep = app.get(DomainVerificationSweepService, { strict: false });
    const result = await sweep.run();
    expect(result.skipped).toBeNull();
    const row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(row.status).toBe('connected');
    expect(row.lastCheckError).toBeNull();
    const back = await request(app.getHttpServer())
      .get(domainPath(academy.id))
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(back.body.customDomain.live).toBe(true);
    expect(back.body.canonicalHost).toEqual({ host: hostname, source: 'custom_domain' });
  });

  it('P63-DOM-023 (C1) — replacing a live domain with one another tenant holds is refused with 409 and the live domain is left UNTOUCHED at the provider; a same-tenant duplicate check still serialises', async () => {
    const a = await seedManagedAcademyWithSubdomain('p63-c1-a');
    const b = await seedManagedAcademyWithSubdomain('p63-c1-b');
    const x = `c1-${run}-x.example.com`;
    const y = `c1-${run}-y.example.com`;
    await addDomain(a.academy.id, a.owner.accessToken, x).expect(201);
    cloudflare.setState(x, 'active', 'active');
    await verify(a.academy.id, a.owner.accessToken).expect(201);
    await addDomain(b.academy.id, b.owner.accessToken, y).expect(201);
    cloudflare.setState(y, 'active', 'active');
    const bLive = await verify(b.academy.id, b.owner.accessToken).expect(201);
    expect(bLive.body.customDomain.live).toBe(true);

    await addDomain(b.academy.id, b.owner.accessToken, x).expect(409);

    // Nothing was released: the provider still holds Y, no ledger row exists.
    expect(cloudflare.has(y)).toBe(true);
    expect(cloudflare.calls.filter((c) => c.startsWith('delete:'))).toHaveLength(0);
    expect(
      await admin.domainProviderRelease.count({ where: { academyId: b.academy.id } }),
    ).toBe(0);
    const still = await verify(b.academy.id, b.owner.accessToken).expect(201);
    expect(still.body.customDomain).toMatchObject({
      hostname: y,
      status: 'connected',
      live: true,
    });
  });

  it('P63-DOM-024 (C1/C6) — a replace that succeeds releases the old resource AFTER commit through the ledger; a failed provider delete is retried by the sweep until the provider confirms', async () => {
    const { owner, academy } = await seedManagedAcademyWithSubdomain('p63-ledger');
    const first = `ledger-${run}-first.example.com`;
    const second = `ledger-${run}-second.example.com`;
    await addDomain(academy.id, owner.accessToken, first).expect(201);
    cloudflare.setState(first, 'active', 'active');
    await verify(academy.id, owner.accessToken).expect(201);

    cloudflare.deletesFail = true;
    const replaced = await addDomain(academy.id, owner.accessToken, second).expect(201);
    expect(replaced.body.customDomain.hostname).toBe(second);
    // The old resource could not be deleted: it is still at the provider,
    // and the ledger remembers it instead of forgetting.
    expect(cloudflare.has(first)).toBe(true);
    const pending = await admin.domainProviderRelease.findFirst({
      where: { academyId: academy.id, hostname: first },
    });
    expect(pending).toMatchObject({
      reason: 'replaced',
      releasedAt: null,
      lastError: 'provider_error',
    });
    expect(pending!.attempts).toBeGreaterThanOrEqual(1);

    // The provider recovers; the sweep retries and the orphan is gone.
    cloudflare.deletesFail = false;
    await admin.domainProviderRelease.update({
      where: { id: pending!.id },
      data: { lastAttemptedAt: new Date('2000-01-01T00:00:00Z') },
    });
    const sweep = app.get(DomainVerificationSweepService, { strict: false });
    const result = await sweep.run();
    expect(result.releasesProcessed).toBeGreaterThanOrEqual(1);
    expect(cloudflare.has(first)).toBe(false);
    const done = await admin.domainProviderRelease.findUniqueOrThrow({
      where: { id: pending!.id },
    });
    expect(done.releasedAt).not.toBeNull();
    expect(done.outcome).toBe('deleted');
    // The new hostname is untouched by the release.
    expect(cloudflare.has(second)).toBe(true);
  });

  it('P63-DOM-025 (C3) — the platform routing target and the platform domain family are refused as custom domains before the provider is asked', async () => {
    const { owner, academy } = await seedManagedAcademyWithSubdomain('p63-reserved-host');
    const target = await addDomain(
      academy.id,
      owner.accessToken,
      'customers.atlas-test.dev',
    );
    expect(target.status).toBe(400);
    expect(target.body.error?.messageKey ?? target.body.messageKey).toBe(
      'errors.domain.hostnameReserved',
    );
    if (envBaseDomain) {
      await addDomain(academy.id, owner.accessToken, envBaseDomain).expect(400);
      await addDomain(
        academy.id,
        owner.accessToken,
        `someone-else.${envBaseDomain}`,
      ).expect(400);
      await addDomain(academy.id, owner.accessToken, `a.b.${envBaseDomain}`).expect(400);
    }
    expect(cloudflare.calls.filter((c) => c.startsWith('create:'))).toHaveLength(0);
    const config = await request(app.getHttpServer())
      .get(domainPath(academy.id))
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(config.body.customDomain).toBeUndefined();
  });

  it('P63-DOM-026 (C11) — a permanently refused registration backs off: after the free retries the sweep leaves the row alone until its backoff has elapsed', async () => {
    const sweep = app.get(DomainVerificationSweepService, { strict: false });
    const { owner, academy } = await seedManagedAcademy('p63-backoff');
    const hostname = `backoff-${run}.example.com`;
    cloudflare.registrationRefusal = { code: 10000, category: 'permission' };
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    // Several refused checks: the counter climbs.
    for (let i = 0; i < 4; i += 1)
      await verify(academy.id, owner.accessToken).expect(201);
    let row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(row.consecutiveFailures).toBe(5);
    // Six minutes old: due on the plain cadence, but NOT within its backoff (20 min for 5 failures).
    await admin.domainConnection.update({
      where: { academyId: academy.id },
      data: { lastCheckedAt: new Date(Date.now() - 6 * 60 * 1000) },
    });
    const createsBefore = cloudflare.calls.filter(
      (c) => c === `create:${hostname}`,
    ).length;
    await sweep.run();
    expect(cloudflare.calls.filter((c) => c === `create:${hostname}`).length).toBe(
      createsBefore,
    );
    // Once the backoff has elapsed it is retried — and succeeds as soon as the provider allows it.
    cloudflare.registrationRefusal = null;
    await admin.domainConnection.update({
      where: { academyId: academy.id },
      data: { lastCheckedAt: new Date('2000-01-01T00:00:00Z') },
    });
    await sweep.run();
    row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(row.status).toBe('verifying');
    expect(row.consecutiveFailures).toBe(0);
  });

  it('P63-DOM-027 (C5) — certificates are ordered with HTTP validation, HTTP validation records are never shown to the customer, and a legacy TXT-validated resource is migrated in place', async () => {
    const { owner, academy } = await seedManagedAcademyWithSubdomain('p63-dcv');
    const hostname = `dcv-${run}.example.com`;
    await addDomain(academy.id, owner.accessToken, hostname).expect(201);
    expect(cloudflare.calls).toContain(`create:${hostname}`);
    cloudflare.setSslMethod(hostname, 'txt');
    const checked = await verify(academy.id, owner.accessToken).expect(201);
    expect(
      cloudflare.calls.some((c) => c.startsWith('sslMethod:') && c.endsWith(':http')),
    ).toBe(true);
    expect(
      checked.body.dns.records.every(
        (r: { type: string }) => r.type.toUpperCase() !== 'HTTP',
      ),
    ).toBe(true);
  });

  it('P63-DOM-028 (C4) — a reserved platform label can never become an Academy slug (and therefore never a public subdomain) through the service that creates Academies', async () => {
    const { owner, org } = await seedManagedAcademy('p63-reserved-slug');
    const academies = app.get(AcademiesService, { strict: false });
    for (const slug of ['www', 'api', 'admin']) {
      await expect(
        academies.create(owner.userId, {
          organizationId: org.id,
          name: `Reserved ${slug}`,
          slug,
        } as never),
      ).rejects.toMatchObject({
        response: { messageKey: 'errors.academy.slugReserved' },
      });
    }
    expect(
      await admin.subdomainAllocation.findUnique({ where: { subdomain: 'www' } }),
    ).toBeNull();
  });

  describe('Platform Owner domain operations', () => {
    it('P63-OPS-001 — every operations endpoint is Platform Owner-only; an organization owner gets 403, anonymous gets 401', async () => {
      const { owner, academy } = await seedManagedAcademy('p63-ops-authz');
      const token = owner.accessToken;
      await request(app.getHttpServer())
        .get('/platform-domains')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(app.getHttpServer())
        .get('/platform-domains/overview')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(app.getHttpServer())
        .get(`/platform-domains/${academy.id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(app.getHttpServer())
        .post(`/platform-domains/${academy.id}/check`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(app.getHttpServer())
        .get('/platform-domain/readiness')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      await request(app.getHttpServer()).get('/platform-domains').expect(401);
    });

    it('P63-OPS-002 — the list is cross-tenant, searchable by hostname/academy/organization, filterable, paginated, and reports attention truthfully', async () => {
      const platformOwner = await seedPlatformOwner('p63-ops-owner');
      const connectedTenant = await seedManagedAcademy('p63-ops-connected');
      const failingTenant = await seedManagedAcademy('p63-ops-failing');
      const subdomainOnly = await seedManagedAcademy('p63-ops-subonly');
      const connectedHost = `ops-${run}-connected.example.com`;
      const failingHost = `ops-${run}-failing.example.com`;
      await addDomain(
        connectedTenant.academy.id,
        connectedTenant.owner.accessToken,
        connectedHost,
      ).expect(201);
      cloudflare.setState(connectedHost, 'active', 'active');
      await verify(connectedTenant.academy.id, connectedTenant.owner.accessToken).expect(
        201,
      );
      await addDomain(
        failingTenant.academy.id,
        failingTenant.owner.accessToken,
        failingHost,
      ).expect(201);
      cloudflare.setState(failingHost, 'blocked', 'validation_timed_out');
      await verify(failingTenant.academy.id, failingTenant.owner.accessToken).expect(201);

      const auth = (r: request.Test) =>
        r.set('Authorization', `Bearer ${platformOwner.accessToken}`);

      const byHostname = await auth(
        request(app.getHttpServer())
          .get('/platform-domains')
          .query({ search: connectedHost }),
      ).expect(200);
      expect(byHostname.body.items).toHaveLength(1);
      expect(byHostname.body.items[0]).toMatchObject({
        academyId: connectedTenant.academy.id,
        organizationId: connectedTenant.org.id,
        needsAttention: false,
        canonicalHost: { host: connectedHost, source: 'custom_domain' },
      });
      expect(byHostname.body.items[0].customDomain).toMatchObject({
        status: 'connected',
        hostname: connectedHost,
      });

      const byOrganization = await auth(
        request(app.getHttpServer())
          .get('/platform-domains')
          .query({ search: `p63-ops-subonly-org` }),
      ).expect(200);
      expect(
        byOrganization.body.items.map((i: { academyId: string }) => i.academyId),
      ).toContain(subdomainOnly.academy.id);
      expect(
        byOrganization.body.items.find(
          (i: { academyId: string }) => i.academyId === subdomainOnly.academy.id,
        ).customDomain,
      ).toBeUndefined();

      const failed = await auth(
        request(app.getHttpServer())
          .get('/platform-domains')
          .query({ status: 'failed', search: `ops-${run}` }),
      ).expect(200);
      expect(failed.body.items.map((i: { academyId: string }) => i.academyId)).toEqual([
        failingTenant.academy.id,
      ]);
      expect(failed.body.items[0].needsAttention).toBe(true);

      const custom = await auth(
        request(app.getHttpServer())
          .get('/platform-domains')
          .query({ kind: 'custom', search: `ops-${run}` }),
      ).expect(200);
      expect(
        custom.body.items.map((i: { academyId: string }) => i.academyId).sort(),
      ).toEqual([connectedTenant.academy.id, failingTenant.academy.id].sort());

      const paged = await auth(
        request(app.getHttpServer())
          .get('/platform-domains')
          .query({ pageSize: 1, page: 2, search: `ops-${run}` }),
      ).expect(200);
      expect(paged.body.items).toHaveLength(1);
      expect(paged.body.pagination).toMatchObject({
        page: 2,
        pageSize: 1,
        totalItems: 2,
      });

      await auth(
        request(app.getHttpServer())
          .get('/platform-domains')
          .query({ sortBy: 'hostname; drop table' }),
      ).expect(400);
      await auth(
        request(app.getHttpServer()).get('/platform-domains').query({ nope: 1 }),
      ).expect(400);

      const overview = await auth(
        request(app.getHttpServer()).get('/platform-domains/overview'),
      ).expect(200);
      expect(overview.body.customConnected).toBeGreaterThanOrEqual(1);
      expect(overview.body.customFailed).toBeGreaterThanOrEqual(1);
      expect(overview.body.needingAttention).toBeGreaterThanOrEqual(1);
      expect(overview.body.academies).toBeGreaterThanOrEqual(
        overview.body.withCustomDomain,
      );
    });

    it('P63-OPS-003 — the operator "check now" re-checks through the platform-update policy, returns the row, and is audited with the operator as actor', async () => {
      const platformOwner = await seedPlatformOwner('p63-ops-check-owner');
      const tenant = await seedManagedAcademy('p63-ops-check');
      const hostname = `ops-${run}-check.example.com`;
      await addDomain(tenant.academy.id, tenant.owner.accessToken, hostname).expect(201);
      cloudflare.setState(hostname, 'active', 'active');

      const checked = await request(app.getHttpServer())
        .post(`/platform-domains/${tenant.academy.id}/check`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(checked.body.customDomain.status).toBe('connected');
      expect(checked.body.organizationName).toBeDefined();

      const audit = await admin.auditLogEntry.findMany({
        where: { action: 'domain.platform_check', academyId: tenant.academy.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorUserId: platformOwner.userId,
        organizationId: tenant.org.id,
        role: 'platform_owner',
      });

      const detail = await request(app.getHttpServer())
        .get(`/platform-domains/${tenant.academy.id}`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(detail.body.customDomain.status).toBe('connected');

      // Nothing to check: honest 404, no audit row.
      const bare = await seedManagedAcademy('p63-ops-check-bare');
      await request(app.getHttpServer())
        .post(`/platform-domains/${bare.academy.id}/check`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(404);
    });

    it('P63-OPS-005 (C14) — a Platform Owner can release a hostname an Academy is holding; the row resets, the provider resource is released, it is audited, and the hostname can then be connected elsewhere', async () => {
      const platformOwner = await seedPlatformOwner('p63-ops-release-owner');
      const holder = await seedManagedAcademyWithSubdomain('p63-holder');
      const claimant = await seedManagedAcademyWithSubdomain('p63-claimant');
      const hostname = `burned-${run}.example.com`;
      await addDomain(holder.academy.id, holder.owner.accessToken, hostname).expect(201);
      cloudflare.setState(hostname, 'active', 'active');
      await verify(holder.academy.id, holder.owner.accessToken).expect(201);
      await addDomain(claimant.academy.id, claimant.owner.accessToken, hostname).expect(
        409,
      );

      // An organization owner cannot use the operator route.
      await request(app.getHttpServer())
        .delete(`/platform-domains/${holder.academy.id}/custom-domain`)
        .set('Authorization', `Bearer ${holder.owner.accessToken}`)
        .expect(403);

      const released = await request(app.getHttpServer())
        .delete(`/platform-domains/${holder.academy.id}/custom-domain`)
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(released.body.customDomain).toBeUndefined();
      expect(cloudflare.has(hostname)).toBe(false);
      const audit = await admin.auditLogEntry.findFirst({
        where: { action: 'domain.platform_release', academyId: holder.academy.id },
      });
      expect(audit?.role).toBe('platform_owner');

      const claimed = await addDomain(
        claimant.academy.id,
        claimant.owner.accessToken,
        hostname,
      ).expect(201);
      expect(claimed.body.customDomain.hostname).toBe(hostname);
    });

    it('P63-OPS-006 (C10) — archiving an Academy releases its custom domain and takes every public read offline, including the by-id endpoints and the contact form', async () => {
      const { owner, academy } = await seedManagedAcademyWithSubdomain('p63-archive');
      const hostname = `archived-${run}.example.com`;
      await addDomain(academy.id, owner.accessToken, hostname).expect(201);
      cloudflare.setState(hostname, 'active', 'active');
      await verify(academy.id, owner.accessToken).expect(201);
      await request(app.getHttpServer())
        .get('/public/websites/resolve')
        .query({ hostname })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/academies/${academy.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(204);

      await request(app.getHttpServer())
        .get('/public/websites/resolve')
        .query({ hostname })
        .expect(404);
      await request(app.getHttpServer())
        .get(`/public/websites/${academy.id}`)
        .expect(404);
      await request(app.getHttpServer())
        .post(`/public/websites/${academy.id}/contact`)
        .send({ name: 'x', email: 'x@example.com', message: 'hello there' })
        .expect(404);
      // The hostname is free again and the provider resource released.
      const row = await admin.domainConnection.findUniqueOrThrow({
        where: { academyId: academy.id },
      });
      expect(row.hostname).toBeNull();
      expect(cloudflare.has(hostname)).toBe(false);
    });

    it('P63-OPS-004 — readiness reports live provider facts; PATCH of the base domain stays allowed here only because no environment value is set', async () => {
      const platformOwner = await seedPlatformOwner('p63-ops-ready-owner');
      const readiness = await request(app.getHttpServer())
        .get('/platform-domain/readiness')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(readiness.body.provider).toEqual({ name: 'cloudflare', connected: true });
      expect(readiness.body.customHostnames).toMatchObject({
        ready: true,
        fallbackOrigin: 'customers.atlas-test.dev',
        originSslMode: 'full',
        originSslModeCompatible: true,
      });
      expect(readiness.body.sweep).toMatchObject({
        pendingReleases: expect.any(Number),
        intervalMs: expect.any(Number),
      });
      expect(readiness.body.source).toBe(
        envBaseDomain ? 'environment' : readiness.body.source,
      );
      if (!envBaseDomain) expect(readiness.body.source).not.toBe('environment');
      cloudflare.fallbackOrigin = null;
      cloudflare.zoneFactsError = { code: 10000, category: 'permission' };
      const notReady = await request(app.getHttpServer())
        .get('/platform-domain/readiness')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(notReady.body.customHostnames.ready).toBe(false);
      expect(notReady.body.customHostnames.fallbackOrigin).toBeUndefined();
      expect(notReady.body.customHostnames).toMatchObject({
        providerErrorCode: '10000',
        providerErrorCategory: 'permission',
        originSslModeState: 'read',
      });

      // P63d — the SSL-mode read refused for lack of "Zone Settings: Read" is
      // reported as exactly that, with the provider's code; the value is never invented.
      cloudflare.zoneSslModeError = { code: 10000, category: 'permission' };
      const notExposed = await request(app.getHttpServer())
        .get('/platform-domain/readiness')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(notExposed.body.customHostnames).toMatchObject({
        originSslModeState: 'permission_missing',
        originSslModeErrorCode: '10000',
      });
      expect(notExposed.body.customHostnames.originSslMode).toBeUndefined();
      expect(notExposed.body.customHostnames.originSslModeCompatible).toBeUndefined();

      // And a read value of `strict` is a misconfiguration, distinct from "unreadable".
      cloudflare.zoneSslModeError = null;
      cloudflare.zoneSslMode = 'strict';
      const strict = await request(app.getHttpServer())
        .get('/platform-domain/readiness')
        .set('Authorization', `Bearer ${platformOwner.accessToken}`)
        .expect(200);
      expect(strict.body.customHostnames).toMatchObject({
        originSslModeState: 'read',
        originSslMode: 'strict',
        originSslModeCompatible: false,
      });
    });
  });

  // ------------------------------------------------------------------ sweep

  describe('Verification sweep', () => {
    it('P63-SWP-001 — re-checks rows still waiting on the provider, skips recently checked ones, moves connected domains forward, and is idempotent', async () => {
      const sweep = app.get(DomainVerificationSweepService, { strict: false });
      const stale = await seedManagedAcademy('p63-swp-stale');
      const fresh = await seedManagedAcademy('p63-swp-fresh');
      const staleHost = `swp-${run}-stale.example.com`;
      const freshHost = `swp-${run}-fresh.example.com`;
      await addDomain(stale.academy.id, stale.owner.accessToken, staleHost).expect(201);
      await addDomain(fresh.academy.id, fresh.owner.accessToken, freshHost).expect(201);
      cloudflare.setState(staleHost, 'active', 'active');
      cloudflare.setState(freshHost, 'active', 'active');
      // The stale row was last checked an hour ago; the fresh one seconds ago.
      await admin.domainConnection.update({
        where: { academyId: stale.academy.id },
        data: { lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000) },
      });

      const first = await sweep.run();
      expect(first.skipped).toBeNull();
      expect(first.checked).toBeGreaterThanOrEqual(1);

      const staleRow = await admin.domainConnection.findUniqueOrThrow({
        where: { academyId: stale.academy.id },
      });
      const freshRow = await admin.domainConnection.findUniqueOrThrow({
        where: { academyId: fresh.academy.id },
      });
      expect(staleRow.status).toBe('connected');
      expect(freshRow.status).toBe('verifying'); // untouched: checked too recently

      // Now connected, the stale row is no longer a sweep candidate: running again changes nothing for it.
      const before = staleRow.updatedAt;
      await sweep.run();
      const after = await admin.domainConnection.findUniqueOrThrow({
        where: { academyId: stale.academy.id },
      });
      expect(after.updatedAt).toEqual(before);
    });

    it('P63-SWP-003 — a connected domain is re-checked on the slow cadence and re-registered when the provider has forgotten it', async () => {
      const sweep = app.get(DomainVerificationSweepService, { strict: false });
      const tenant = await seedManagedAcademy('p63-swp-connected');
      const hostname = `swp-${run}-connected.example.com`;
      await addDomain(tenant.academy.id, tenant.owner.accessToken, hostname).expect(201);
      cloudflare.setState(hostname, 'active', 'active');
      await verify(tenant.academy.id, tenant.owner.accessToken).expect(201);

      // Checked just now: not due on either cadence.
      await sweep.run();
      let row = await admin.domainConnection.findUniqueOrThrow({
        where: { academyId: tenant.academy.id },
      });
      expect(row.status).toBe('connected');

      // Seven hours later the provider no longer knows the hostname.
      await admin.domainConnection.update({
        where: { academyId: tenant.academy.id },
        data: { lastCheckedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) },
      });
      cloudflare.forget(hostname);
      await sweep.run();
      row = await admin.domainConnection.findUniqueOrThrow({
        where: { academyId: tenant.academy.id },
      });
      // P63g — re-registered by the sweep itself: back to verifying with a
      // fresh provider resource, demoted from canonical meanwhile.
      expect(row.status).toBe('verifying');
      expect(row.lastCheckError).toBeNull();
      expect(cloudflare.has(hostname)).toBe(true);
    });

    it('P63-SWP-002 — without provider credentials the sweep skips entirely rather than stamping errors on every pending row', async () => {
      const sweep = app.get(DomainVerificationSweepService, { strict: false });
      const tenant = await seedManagedAcademy('p63-swp-nocreds');
      const hostname = `swp-${run}-nocreds.example.com`;
      await addDomain(tenant.academy.id, tenant.owner.accessToken, hostname).expect(201);
      await admin.domainConnection.update({
        where: { academyId: tenant.academy.id },
        data: {
          lastCheckedAt: new Date(Date.now() - 60 * 60 * 1000),
          lastCheckError: null,
        },
      });
      cloudflare.connected = false;
      const result = await sweep.run();
      expect(result.skipped).toBe('provider_unavailable');
      const row = await admin.domainConnection.findUniqueOrThrow({
        where: { academyId: tenant.academy.id },
      });
      expect(row.lastCheckError).toBeNull();
    });
  });
});
