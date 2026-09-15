/**
 * Zoom deauthorization against REAL Postgres, with RLS enforced.
 *
 * WHY THIS FILE EXISTS ALONGSIDE THE CONTROLLER SPEC. That spec proves
 * nothing unsigned gets in. This one proves what happens after: that the
 * account_id → academy bridge resolves under the platform-owner SELECT
 * policy, that the write lands under the tenant UPDATE policy, that a
 * redelivery is a no-op, that a stale notification cannot clear a fresh
 * authorization, and that one academy's deauthorization cannot touch
 * another's. None of that is provable with mocks — the policies ARE the
 * behaviour, so the system under test is the app's own `PrismaService`,
 * connected as the restricted `atlas_app` role, exactly as every other
 * e2e spec in this directory does it.
 */
import { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { LiveProviderDeauthorizationService } from '../src/live-sessions/services/live-provider-deauthorization.service';
import type { ExtractedZoomDeauthorization } from '../src/live-sessions/utils/zoom-deauthorization.util';

const CLIENT_ID = 'atlas-zoom-client-id';

describe('Zoom deauthorization (real Postgres, RLS enforced)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenancyContext: TenancyContextService;
  let service: LiveProviderDeauthorizationService;
  let admin: PrismaClient;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    tenancyContext = app.get(TenancyContextService, { strict: false });
    service = app.get(LiveProviderDeauthorizationService, { strict: false });
    admin = createAdminPrisma();

    // A platform owner must exist — it is the identity the account
    // lookup runs as, and the actor recorded on the audit entry.
    const existing = await admin.user.findFirst({ where: { isPlatformOwner: true } });
    if (!existing) {
      await admin.user.create({
        data: {
          email: uniqueTestEmail('deauth-platform-owner'),
          name: 'Deauth Platform Owner',
          passwordHash: 'x',
          isPlatformOwner: true,
          emailVerifiedAt: new Date(),
        },
      });
    }
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  let seq = 0;
  async function seedConnectedAcademy(label: string, accountId: string) {
    seq += 1;
    const unique = `${label}-${Date.now()}-${seq}`;
    const owner = await admin.user.create({
      data: {
        email: uniqueTestEmail(`${label}-owner`),
        name: `${label} owner`,
        passwordHash: 'x',
        emailVerifiedAt: new Date(),
      },
    });
    const org = await admin.organization.create({
      data: { name: unique, slug: `org-${unique}`, ownerUserId: owner.id },
    });
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: owner.id, role: 'owner', isPrimary: true },
    });
    const academy = await admin.academy.create({
      data: { organizationId: org.id, name: unique, slug: `acad-${unique}` },
    });
    const connection = await admin.academyLiveProviderConnection.create({
      data: {
        academyId: academy.id,
        providerKey: 'zoom',
        status: 'connected',
        externalAccountId: accountId,
        encryptedCredentials: 'ciphertext-placeholder',
        refreshTokenFingerprint: 'fingerprint-placeholder',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
        grantedScopes: ['meeting:write:meeting:admin'],
        externalUserId: 'zoom-user-x',
        externalUserEmail: 'host@example.test',
        connectedAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
    return { owner, org, academy, connection };
  }

  const event = (
    accountId: string,
    over: Partial<ExtractedZoomDeauthorization> = {},
  ): ExtractedZoomDeauthorization => ({
    accountId,
    clientId: CLIENT_ID,
    zoomUserId: 'zoom-user-x',
    deauthorizedAt: new Date('2026-09-10T00:00:00.000Z'),
    ...over,
  });

  const readConnection = (organizationId: string, id: string) =>
    tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.academyLiveProviderConnection.findUnique({ where: { id } }),
    );

  it('invalidates the correct connection and clears every piece of token material', async () => {
    const acct = `zoom-acct-ok-${Date.now()}`;
    const { org, connection } = await seedConnectedAcademy('deauth-ok', acct);

    await expect(service.handle(event(acct))).resolves.toBe('invalidated');

    const after = await readConnection(org.id, connection.id);
    expect(after?.status).toBe('revoked');
    expect(after?.encryptedCredentials).toBeNull();
    expect(after?.refreshTokenFingerprint).toBeNull();
    expect(after?.accessTokenExpiresAt).toBeNull();
    expect(after?.refreshTokenExpiresAt).toBeNull();
    expect(after?.grantedScopes).toEqual([]);
    expect(after?.externalUserId).toBeNull();
    expect(after?.externalUserEmail).toBeNull();
    expect(after?.connectedAt).toBeNull();
    // KEPT, per the connection lifecycle's own design: the screen still
    // says which Zoom account was attached, and a revoked row is outside
    // the partial unique index so the customer can rebind.
    expect(after?.externalAccountId).toBe(acct);
  });

  it('records an audit entry with no secret material', async () => {
    const acct = `zoom-acct-audit-${Date.now()}`;
    const { connection } = await seedConnectedAcademy('deauth-audit', acct);

    await service.handle(event(acct));

    const entries = await admin.auditLogEntry.findMany({
      where: { action: 'live_provider.deauthorized', targetId: connection.id },
    });
    expect(entries).toHaveLength(1);
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).toContain(acct);
    expect(serialized).not.toMatch(/ciphertext-placeholder|fingerprint-placeholder/);
  });

  it('notifies the Organization Owner through the existing fan-out', async () => {
    const acct = `zoom-acct-notify-${Date.now()}`;
    const { owner } = await seedConnectedAcademy('deauth-notify', acct);

    await service.handle(event(acct));

    const notifications = await admin.notification.findMany({
      where: {
        userId: owner.id,
        titleKey: 'notifications:liveProvider.deauthorized.title',
      },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].actionUrl).toBe(
      '/dashboard/add-ons/live-sessions/connection',
    );
  });

  /* IDEMPOTENCY. A redelivery must be a silent no-op, not a second write. */
  it('is idempotent across repeated deliveries', async () => {
    const acct = `zoom-acct-idem-${Date.now()}`;
    const { org, connection } = await seedConnectedAcademy('deauth-idem', acct);

    await expect(service.handle(event(acct))).resolves.toBe('invalidated');
    await expect(service.handle(event(acct))).resolves.toBe('already_invalidated');
    await expect(service.handle(event(acct))).resolves.toBe('already_invalidated');

    const after = await readConnection(org.id, connection.id);
    expect(after?.status).toBe('revoked');

    const entries = await admin.auditLogEntry.findMany({
      where: { action: 'live_provider.deauthorized', targetId: connection.id },
    });
    // Exactly one — the redeliveries wrote nothing at all.
    expect(entries).toHaveLength(1);
  });

  /*
    THE STALE-NOTIFICATION GUARD — the race that would otherwise break a
    customer who did everything right: they reconnected, and a delayed
    announcement about the OLD authorization arrives afterwards.
  */
  it('does NOT clear an authorization newer than the deauthorization', async () => {
    const acct = `zoom-acct-stale-${Date.now()}`;
    const { org, connection } = await seedConnectedAcademy('deauth-stale', acct);

    // The customer reconnected after Zoom sent the notification.
    await admin.academyLiveProviderConnection.update({
      where: { id: connection.id },
      data: { connectedAt: new Date('2026-09-20T00:00:00.000Z') },
    });

    await expect(
      service.handle(
        event(acct, { deauthorizedAt: new Date('2026-09-10T00:00:00.000Z') }),
      ),
    ).resolves.toBe('stale_ignored');

    const after = await readConnection(org.id, connection.id);
    expect(after?.status).toBe('connected');
    expect(after?.encryptedCredentials).not.toBeNull();
  });

  it('DOES clear when the deauthorization is newer than the authorization', async () => {
    const acct = `zoom-acct-fresh-${Date.now()}`;
    const { org, connection } = await seedConnectedAcademy('deauth-fresh', acct);

    await expect(
      service.handle(
        event(acct, { deauthorizedAt: new Date('2026-09-30T00:00:00.000Z') }),
      ),
    ).resolves.toBe('invalidated');

    const after = await readConnection(org.id, connection.id);
    expect(after?.status).toBe('revoked');
  });

  it('does nothing for a Zoom account Atlas has never seen', async () => {
    const acct = `zoom-acct-known-${Date.now()}`;
    const { org, connection } = await seedConnectedAcademy('deauth-unknown', acct);

    await expect(service.handle(event(`totally-unknown-${Date.now()}`))).resolves.toBe(
      'unknown_account',
    );

    const untouched = await readConnection(org.id, connection.id);
    expect(untouched?.status).toBe('connected');
    expect(untouched?.encryptedCredentials).not.toBeNull();
  });

  /*
    CROSS-TENANT. Deauthorizing academy A's Zoom account must not touch
    academy B's connection, even though both rows live in the same table.
  */
  it('cannot invalidate another academy’s connection', async () => {
    const acctA = `zoom-acct-a-${Date.now()}`;
    const acctB = `zoom-acct-b-${Date.now()}`;
    const a = await seedConnectedAcademy('deauth-tenant-a', acctA);
    const b = await seedConnectedAcademy('deauth-tenant-b', acctB);

    await expect(service.handle(event(acctA))).resolves.toBe('invalidated');

    expect((await readConnection(a.org.id, a.connection.id))?.status).toBe('revoked');

    const untouched = await readConnection(b.org.id, b.connection.id);
    expect(untouched?.status).toBe('connected');
    expect(untouched?.encryptedCredentials).not.toBeNull();
  });

  /*
    RLS IS STILL ON. The write above succeeded through the tenant policy —
    this proves the table has not been left readable to a context that
    should not see it, i.e. the handler did not achieve its job by
    weakening anything.
  */
  it('keeps RLS enforced — a foreign tenant context cannot see the row', async () => {
    const acct = `zoom-acct-rls-${Date.now()}`;
    const a = await seedConnectedAcademy('deauth-rls-a', acct);
    const b = await seedConnectedAcademy(
      'deauth-rls-b',
      `zoom-acct-rls-other-${Date.now()}`,
    );

    await service.handle(event(acct));

    // B's tenant context must not see A's connection at all.
    const leaked = await tenancyContext.runInTenantContext(b.org.id, (tx) =>
      tx.academyLiveProviderConnection.findMany({ where: { id: a.connection.id } }),
    );
    expect(leaked).toEqual([]);

    // And a context with no tenant set sees nothing either.
    const noContext = await prisma.academyLiveProviderConnection.findMany({
      where: { id: a.connection.id },
    });
    expect(noContext).toEqual([]);
  });
});
