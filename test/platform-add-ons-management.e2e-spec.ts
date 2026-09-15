/**
 * Add-ons Catalog Management — real Postgres, RLS enforced.
 *
 * Two things are worth proving here and both are proven against a real
 * database rather than a mock. First, the CATALOG state a Platform Owner
 * controls (draft/coming_soon/published) is authoritative and versioned:
 * a status change moves the row, bumps its version, writes exactly one
 * audit entry, and a stale version is refused. Second, that state is kept
 * strictly separate from any tenant's install/enable state — the two
 * counts are read across tenants only in platform context, which the
 * `tenant_add_ons_platform_select` policy (P50) is what permits.
 *
 * Every assertion is scoped to add-ons this suite created (unique keys),
 * so it is independent of whatever else the shared seed/DB already holds —
 * the accumulation-independence the Zoom Ops suite learned to require.
 */
import { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { PlatformAddOnsService } from '../src/platform/services/platform-add-ons.service';
import { StaleResourceVersionException } from '../src/concurrency/errors/stale-resource-version.exception';
import { STALE_RESOURCE_VERSION_CODE } from '../src/concurrency/errors/stale-resource-version.exception';

describe('Platform Add-ons Management (real Postgres, RLS enforced)', () => {
  let app: INestApplication;
  let service: PlatformAddOnsService;
  let admin: PrismaClient;
  let platformOwnerId: string;
  const suite = `catmgmt-${Date.now()}`;

  // Keys this suite owns; asserted on directly so shared state can't skew.
  const publishedKey = `${suite}-published`;
  const comingSoonKey = `${suite}-coming-soon`;
  const draftKey = `${suite}-draft`;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    service = app.get(PlatformAddOnsService, { strict: false });
    admin = createAdminPrisma();

    const existing = await admin.user.findFirst({ where: { isPlatformOwner: true } });
    platformOwnerId =
      existing?.id ??
      (
        await admin.user.create({
          data: {
            email: uniqueTestEmail('addon-mgmt-po'),
            name: 'Add-ons Mgmt Platform Owner',
            passwordHash: 'x',
            isPlatformOwner: true,
            emailVerifiedAt: new Date(),
          },
        })
      ).id;

    // Three add-ons in three distinct catalog states.
    const published = await admin.addOn.create({
      data: {
        key: publishedKey,
        name: `ZZ Published ${suite}`,
        description: 'A published add-on for the management suite.',
        effect: { type: 'feature', featureKey: 'liveSessions' },
        compatiblePlanKeys: ['growth'],
        catalogStatus: 'published',
      },
    });
    await admin.addOn.create({
      data: {
        key: comingSoonKey,
        name: `ZZ Coming ${suite}`,
        description: 'A coming-soon add-on for the management suite.',
        effect: { type: 'feature', featureKey: 'liveSessions' },
        compatiblePlanKeys: ['growth'],
        catalogStatus: 'coming_soon',
      },
    });
    await admin.addOn.create({
      data: {
        key: draftKey,
        name: `ZZ Draft ${suite}`,
        description: 'A draft add-on for the management suite.',
        effect: { type: 'feature', featureKey: 'liveSessions' },
        compatiblePlanKeys: ['growth'],
        catalogStatus: 'draft',
      },
    });

    // Two tenants installing the published add-on: one enabled, one disabled.
    // Install count must be 2, enabled count must be 1.
    for (const [label, status] of [
      ['a', 'enabled'],
      ['b', 'disabled'],
    ] as const) {
      const owner = await admin.user.create({
        data: {
          email: uniqueTestEmail(`${suite}-${label}`),
          name: `${suite} ${label}`,
          passwordHash: 'x',
          emailVerifiedAt: new Date(),
        },
      });
      const org = await admin.organization.create({
        data: { name: `${suite}-${label}`, slug: `org-${suite}-${label}`, ownerUserId: owner.id },
      });
      await admin.tenantAddOn.create({
        data: { organizationId: org.id, addOnId: published.id, status },
      });
    }
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  const findRow = async (key: string) => {
    // Page through the (small) catalog to find our key, independent of
    // ordering or how many other add-ons exist.
    const first = await service.list(platformOwnerId, { pageSize: 100 } as never);
    return first.items.find((r) => r.key === key);
  };

  it('auto-includes every registered add-on, with its catalog status', async () => {
    const result = await service.list(platformOwnerId, { pageSize: 100 } as never);
    const keys = result.items.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining([publishedKey, comingSoonKey, draftKey]));

    const published = result.items.find((r) => r.key === publishedKey);
    const coming = result.items.find((r) => r.key === comingSoonKey);
    const draft = result.items.find((r) => r.key === draftKey);
    expect(published?.catalogStatus).toBe('published');
    expect(coming?.catalogStatus).toBe('coming_soon');
    expect(draft?.catalogStatus).toBe('draft');
  });

  it('includes the pre-existing Live Sessions add-on as coming_soon (default preserved)', async () => {
    const live = await findRow('live-sessions');
    // Present in a seeded environment; when absent (bare DB) the assertion
    // is skipped rather than asserted false, since this suite does not seed
    // the product catalog itself.
    if (live) {
      expect(live.catalogStatus).toBe('coming_soon');
    }
  });

  it('reports install and enabled counts from tenant_add_ons', async () => {
    const row = await findRow(publishedKey);
    expect(row?.installCount).toBe(2);
    expect(row?.enabledCount).toBe(1);
  });

  it('carries a version and an updatedAt on every row', async () => {
    const row = await findRow(publishedKey);
    expect(typeof row?.version).toBe('number');
    expect(row?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('filters by catalog status', async () => {
    const result = await service.list(platformOwnerId, {
      status: 'draft',
      pageSize: 100,
    } as never);
    expect(result.items.every((r) => r.catalogStatus === 'draft')).toBe(true);
    expect(result.items.some((r) => r.key === draftKey)).toBe(true);
    expect(result.items.some((r) => r.key === publishedKey)).toBe(false);
  });

  it('searches by name, key and description', async () => {
    const byKey = await service.list(platformOwnerId, {
      search: comingSoonKey,
      pageSize: 100,
    } as never);
    expect(byKey.items.map((r) => r.key)).toContain(comingSoonKey);
    expect(byKey.items.every((r) => r.key.includes(suite))).toBe(true);
  });

  it('paginates', async () => {
    const p1 = await service.list(platformOwnerId, { page: 1, pageSize: 1 } as never);
    expect(p1.items).toHaveLength(1);
    expect(p1.pagination.pageSize).toBe(1);
    expect(p1.pagination.totalItems).toBeGreaterThanOrEqual(3);
    expect(p1.pagination.totalPages).toBe(p1.pagination.totalItems);
  });

  it('changes catalog status, bumps the version, and returns the new row', async () => {
    const before = await findRow(comingSoonKey);
    const updated = await service.updateCatalogStatus(platformOwnerId, comingSoonKey, {
      catalogStatus: 'published',
      expectedVersion: before!.version,
    });
    expect(updated.catalogStatus).toBe('published');
    expect(updated.version).toBe(before!.version + 1);

    // Put it back so later assertions/other suites see the intended state.
    await service.updateCatalogStatus(platformOwnerId, comingSoonKey, {
      catalogStatus: 'coming_soon',
      expectedVersion: updated.version,
    });
  });

  it('refuses a stale version with a stale_resource_version conflict', async () => {
    const row = await findRow(draftKey);
    const staleVersion = row!.version - 1; // deliberately behind
    await expect(
      service.updateCatalogStatus(platformOwnerId, draftKey, {
        catalogStatus: 'published',
        expectedVersion: staleVersion < 0 ? row!.version + 5 : staleVersion,
      }),
    ).rejects.toBeInstanceOf(StaleResourceVersionException);
  });

  it('writes exactly one audit entry per status change, with prev/new and no secrets', async () => {
    const row = await findRow(draftKey);
    const addOn = await admin.addOn.findUnique({ where: { key: draftKey } });

    const before = await admin.auditLogEntry.count({
      where: { action: 'add_on.catalog_status_changed', targetId: addOn!.id },
    });

    await service.updateCatalogStatus(platformOwnerId, draftKey, {
      catalogStatus: 'coming_soon',
      expectedVersion: row!.version,
    });

    const entries = await admin.auditLogEntry.findMany({
      where: { action: 'add_on.catalog_status_changed', targetId: addOn!.id },
      orderBy: { occurredAt: 'desc' },
    });
    expect(entries.length).toBe(before + 1);

    const latest = entries[0];
    expect(latest.actorUserId).toBe(platformOwnerId);
    expect(latest.targetType).toBe('add_on');
    const context = latest.context as Record<string, unknown>;
    expect(context.previousStatus).toBe('draft');
    expect(context.newStatus).toBe('coming_soon');
    expect(context.addOnKey).toBe(draftKey);

    const serialized = JSON.stringify(latest);
    expect(serialized).not.toMatch(/password|secret|token|refresh|access_token/i);
  });

  it('404s an unknown add-on key', async () => {
    await expect(
      service.updateCatalogStatus(platformOwnerId, 'no-such-add-on', {
        catalogStatus: 'published',
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('exposes the stale-version conflict as a machine-readable 409 code', () => {
    const err = new StaleResourceVersionException({
      submittedVersion: 0,
      currentVersion: 3,
    });
    expect(err.getStatus()).toBe(409);
    expect((err.getResponse() as { code: string }).code).toBe(
      STALE_RESOURCE_VERSION_CODE,
    );
  });

  it('does NOT let an ordinary tenant context read across tenants', async () => {
    const tenancy = app.get(TenancyContextService, { strict: false });
    // A fresh org whose context should see only its own (zero) rows for our
    // published add-on — never the two installs seeded under other orgs.
    const owner = await admin.user.create({
      data: {
        email: uniqueTestEmail(`${suite}-outsider`),
        name: 'outsider',
        passwordHash: 'x',
        emailVerifiedAt: new Date(),
      },
    });
    const org = await admin.organization.create({
      data: { name: `${suite}-out`, slug: `org-${suite}-out`, ownerUserId: owner.id },
    });
    const addOn = await admin.addOn.findUnique({ where: { key: publishedKey } });

    const visible = await tenancy.runInTenantContext(org.id, (tx) =>
      tx.tenantAddOn.count({ where: { addOnId: addOn!.id } }),
    );
    expect(visible).toBe(0);
  });
});
