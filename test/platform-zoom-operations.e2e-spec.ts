/**
 * Zoom Operations Center — real Postgres, RLS enforced.
 *
 * The two claims worth proving are the security ones: that a platform
 * owner's context can read across tenants (otherwise every page is
 * silently empty, the exact failure P46 was written to fix), and that an
 * ordinary tenant context still cannot — so the new `_platform_select`
 * policies widened nothing for anybody else.
 *
 * Everything runs through the app's own `PrismaService`, connected as the
 * restricted `atlas_app` role. Fixtures are arranged with the elevated
 * admin client, exactly as the other e2e specs do.
 */
import { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { PlatformZoomService } from '../src/platform/services/platform-zoom.service';

describe('Platform Zoom Operations (real Postgres, RLS enforced)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenancyContext: TenancyContextService;
  let service: PlatformZoomService;
  let admin: PrismaClient;
  let platformOwnerId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    tenancyContext = app.get(TenancyContextService, { strict: false });
    service = app.get(PlatformZoomService, { strict: false });
    admin = createAdminPrisma();

    const existing = await admin.user.findFirst({ where: { isPlatformOwner: true } });
    platformOwnerId =
      existing?.id ??
      (
        await admin.user.create({
          data: {
            email: uniqueTestEmail('zoom-ops-po'),
            name: 'Zoom Ops Platform Owner',
            passwordHash: 'x',
            isPlatformOwner: true,
            emailVerifiedAt: new Date(),
          },
        })
      ).id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  let seq = 0;
  async function seedAcademy(label: string, connectionStatus: string | null) {
    seq += 1;
    const unique = `${label}-${Date.now()}-${seq}`;
    const owner = await admin.user.create({
      data: {
        email: uniqueTestEmail(`${label}-o`),
        name: `${label} owner`,
        passwordHash: 'x',
        emailVerifiedAt: new Date(),
      },
    });
    const org = await admin.organization.create({
      data: { name: unique, slug: `org-${unique}`, ownerUserId: owner.id },
    });
    const academy = await admin.academy.create({
      data: { organizationId: org.id, name: unique, slug: `acad-${unique}` },
    });
    if (connectionStatus) {
      await admin.academyLiveProviderConnection.create({
        data: {
          academyId: academy.id,
          providerKey: 'zoom',
          status: connectionStatus as never,
          externalAccountId: `acct-${unique}`,
          encryptedCredentials: connectionStatus === 'connected' ? 'ct' : null,
          connectedAt: connectionStatus === 'connected' ? new Date() : null,
        },
      });
    }
    return { owner, org, academy };
  }

  describe('platform-owner reads work across tenants', () => {
    it('lists connections from every organization, including academies with none', async () => {
      const connected = await seedAcademy('zops-connected', 'connected');
      const revoked = await seedAcademy('zops-revoked', 'revoked');
      const never = await seedAcademy('zops-never', null);

      const all = await service.listConnections(platformOwnerId, { pageSize: 100 });
      const byId = new Map(all.items.map((i) => [i.academyId, i]));

      expect(byId.get(connected.academy.id)?.status).toBe('connected');
      expect(byId.get(revoked.academy.id)?.status).toBe('revoked');
      // The row that would be invisible if the list were based on connections.
      expect(byId.get(never.academy.id)?.status).toBe('not_connected');
    });

    it('flags exactly the issue states', async () => {
      const revoked = await seedAcademy('zops-issue', 'revoked');
      const ok = await seedAcademy('zops-ok', 'connected');

      const all = await service.listConnections(platformOwnerId, { pageSize: 100 });
      const byId = new Map(all.items.map((i) => [i.academyId, i]));

      expect(byId.get(revoked.academy.id)?.hasIssue).toBe(true);
      expect(byId.get(ok.academy.id)?.hasIssue).toBe(false);
    });

    it('returns bounded overview aggregates', async () => {
      await seedAcademy('zops-overview', 'connected');
      const overview = await service.getOverview(platformOwnerId);

      expect(overview.connections.connected).toBeGreaterThan(0);
      expect(typeof overview.connections.notInstalled).toBe('number');
      expect(Array.isArray(overview.needsAttention)).toBe(true);
      expect(Array.isArray(overview.upcomingAtRisk)).toBe(true);
      expect(overview.upcomingAtRisk.length).toBeLessThanOrEqual(10);
      expect(overview.recentActivity.length).toBeLessThanOrEqual(10);
    });

    it('paginates server-side', async () => {
      const page = await service.listConnections(platformOwnerId, {
        page: 1,
        pageSize: 2,
      });
      expect(page.items.length).toBeLessThanOrEqual(2);
      expect(page.pagination.pageSize).toBe(2);
      expect(page.pagination.totalItems).toBeGreaterThanOrEqual(page.items.length);
    });

    it('filters by status server-side', async () => {
      await seedAcademy('zops-filter', 'revoked');
      const revokedOnly = await service.listConnections(platformOwnerId, {
        status: 'revoked',
        pageSize: 100,
      });
      expect(revokedOnly.items.length).toBeGreaterThan(0);
      expect(revokedOnly.items.every((i) => i.status === 'revoked')).toBe(true);
    });
  });

  describe('no secret material ever leaves the service', () => {
    it('masks the provider account id and returns no credentials', async () => {
      const seeded = await seedAcademy('zops-secret', 'connected');
      const accountId = `acct-`;

      const all = await service.listConnections(platformOwnerId, { pageSize: 100 });
      const row = all.items.find((i) => i.academyId === seeded.academy.id);

      expect(row?.maskedAccountId).toBeDefined();
      // Masked, not the stored value.
      expect(row?.maskedAccountId).toContain('•');

      const serialized = JSON.stringify(all);
      expect(serialized).not.toMatch(
        /encryptedCredentials|refreshToken|accessToken|"ct"/,
      );
      expect(serialized).not.toMatch(/client_secret|clientSecret|webhookSecret/i);
      expect(accountId).toBeTruthy();
    });

    it('returns no token material on the sessions endpoint', async () => {
      const sessions = await service.listSessions(platformOwnerId, { pageSize: 20 });
      const serialized = JSON.stringify(sessions);
      expect(serialized).not.toMatch(
        /encryptedCredentials|refreshToken|accessToken|signature/i,
      );
    });
  });

  /*
    THE POLICIES WIDENED NOTHING. P50 added `_platform_select` to four
    tables; these prove a tenant context still sees only its own rows and
    a context with no tenant sees nothing at all.
  */
  describe('RLS independently agrees', () => {
    it('a tenant context cannot read another organization’s connection', async () => {
      const a = await seedAcademy('zops-rls-a', 'connected');
      const b = await seedAcademy('zops-rls-b', 'connected');

      const leaked = await tenancyContext.runInTenantContext(b.org.id, (tx) =>
        tx.academyLiveProviderConnection.findMany({ where: { academyId: a.academy.id } }),
      );
      expect(leaked).toEqual([]);
    });

    it('a context with no tenant and no platform owner sees nothing', async () => {
      const a = await seedAcademy('zops-rls-none', 'connected');
      const rows = await prisma.academyLiveProviderConnection.findMany({
        where: { academyId: a.academy.id },
      });
      expect(rows).toEqual([]);
    });

    it('an ordinary user context is NOT treated as a platform owner', async () => {
      const a = await seedAcademy('zops-rls-user', 'connected');

      const asOrdinaryUser = await tenancyContext.runInUserContext(a.owner.id, (tx) =>
        tx.academyLiveProviderConnection.findMany({ where: { academyId: a.academy.id } }),
      );
      // `is_platform_owner` is false for them, and there is no tenant
      // context set, so the platform policy does not apply.
      expect(asOrdinaryUser).toEqual([]);
    });

    it('P50 tables stay tenant-isolated for ordinary contexts', async () => {
      const a = await seedAcademy('zops-rls-p50a', 'connected');
      const b = await seedAcademy('zops-rls-p50b', 'connected');

      const addOns = await tenancyContext.runInTenantContext(b.org.id, (tx) =>
        tx.tenantAddOn.findMany({ where: { organizationId: a.org.id } }),
      );
      expect(addOns).toEqual([]);
    });
  });

  describe('Part 2 — attendance, recordings, events, activity, academy detail', () => {
    it('lists recordings across tenants with quota flag from quotaConsumedAt, not file count', async () => {
      const acct = `zops-rec-${Date.now()}`;
      const seeded = await seedAcademy('zops-rec', 'connected');
      // Seed a course + session + recording via admin (fixture arrangement).
      const course = await admin.course.create({
        data: { academyId: seeded.academy.id, title: 'Rec Course', slug: `rc-${Date.now()}`},
      });
      const session = await admin.liveSession.create({
        data: {
          courseId: course.id, academyId: seeded.academy.id, title: 'Rec Session',
          status: 'ended', scheduledStartAt: new Date(Date.now()-7200e3),
          scheduledEndAt: new Date(Date.now()-3600e3), hostUserId: seeded.owner.id,
          recordingEnabled: true, endedAt: new Date(Date.now()-3600e3),
        },
      });
      await admin.liveSessionRecording.create({
        data: {
          liveSessionId: session.id, academyId: seeded.academy.id,
          organizationId: seeded.org.id, status: 'available',
          quotaConsumedAt: new Date(), availableAt: new Date(),
        },
      });
      const recs = await service.listRecordings(platformOwnerId, { pageSize: 100 });
      const row = recs.items.find((r) => r.sessionId === session.id);
      expect(row?.status).toBe('available');
      expect(row?.quotaConsumed).toBe(true);
      expect(row?.fileCount).toBe(0);
      expect(acct).toBeTruthy();
    });

    it('derives attendance reconciliation state from stored fields', async () => {
      const seeded = await seedAcademy('zops-att', 'connected');
      const course = await admin.course.create({
        data: { academyId: seeded.academy.id, title: 'Att Course', slug: `ac-${Date.now()}`},
      });
      // ended + reconciled
      await admin.liveSession.create({
        data: {
          courseId: course.id, academyId: seeded.academy.id, title: 'Reconciled', status: 'ended',
          scheduledStartAt: new Date(Date.now()-7200e3), scheduledEndAt: new Date(Date.now()-3600e3),
          hostUserId: seeded.owner.id, endedAt: new Date(Date.now()-3600e3), attendanceReconciledAt: new Date(),
        },
      });
      const att = await service.listAttendance(platformOwnerId, { academyId: seeded.academy.id, pageSize: 100 });
      expect(att.items.some((a) => a.reconciliationState === 'reconciled')).toBe(true);
    });

    it('returns event health counts and rows', async () => {
      const events = await service.listEvents(platformOwnerId, { pageSize: 20 });
      expect(events.health).toBeDefined();
      expect(typeof events.health.received).toBe('number');
      expect(Array.isArray(events.health.byType)).toBe(true);
    });

    it('lists only the five real Zoom audit actions in activity', async () => {
      const activity = await service.listActivity(platformOwnerId, { pageSize: 50 });
      const allowed = new Set([
        'live_provider.connected', 'live_provider.disconnected', 'live_provider.deauthorized',
        'live_session.created', 'live_session.published',
      ]);
      expect(activity.items.every((a) => allowed.has(a.action))).toBe(true);
    });

    it('academy detail returns entitlement-backed quota and no secrets', async () => {
      const seeded = await seedAcademy('zops-detail', 'connected');
      const detail = await service.getAcademyDetail(platformOwnerId, seeded.academy.id);
      expect(detail).not.toBeNull();
      expect(detail!.recordings.quotaUsed).toBeGreaterThanOrEqual(0);
      expect(['number', 'string']).toContain(typeof detail!.recordings.quotaLimit);
      expect(detail!.connection.maskedAccountId).toContain('•');
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toMatch(/encryptedCredentials|refreshToken|accessToken|"ct"/);
    });

    it('academy detail returns null for an unknown academy', async () => {
      const detail = await service.getAcademyDetail(platformOwnerId, '00000000-0000-0000-0000-000000000000');
      expect(detail).toBeNull();
    });

    it('a tenant context still cannot read another org recordings (P50 select is platform-only)', async () => {
      const a = await seedAcademy('zops-p2rls-a', 'connected');
      const b = await seedAcademy('zops-p2rls-b', 'connected');
      const course = await admin.course.create({
        data: { academyId: a.academy.id, title: 'X', slug: `x-${Date.now()}`},
      });
      const s2 = await admin.liveSession.create({
        data: {
          courseId: course.id, academyId: a.academy.id, title: 'S', status: 'ended',
          scheduledStartAt: new Date(), scheduledEndAt: new Date(), hostUserId: a.owner.id,
        },
      });
      await admin.liveSessionRecording.create({
        data: { liveSessionId: s2.id, academyId: a.academy.id, organizationId: a.org.id, status: 'available' },
      });
      const leaked = await tenancyContext.runInTenantContext(b.org.id, (tx) =>
        tx.liveSessionRecording.findMany({ where: { academyId: a.academy.id } }),
      );
      expect(leaked).toEqual([]);
    });
  });

});
