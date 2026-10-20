/**
 * Academy address change — the website moves, the old address redirects
 * (owner decision, 20 Oct 2026; migration 20261123000000_subdomain_aliases).
 *
 * THE DEFECT THIS PINS. Saving a new Academy Slug changed only
 * `academies.slug`; the public website, email links and invite links follow
 * `subdomain_allocations`, which kept the old label — the new address
 * opened nothing — and the old label was free again in `academies.slug`
 * while the allocation still held it.
 *
 * The suite runs with a platform base domain so hosts resolve the way they
 * do in production (`<label>.<base>`). Academies are seeded with the
 * allocation the application always creates (`subdomain = slug`,
 * P104-SUB-008).
 */
import { INestApplication } from '@nestjs/common';
import { spawnSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  fixtureUsers,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { LinkBuilderService } from '../src/communications/services/link-builder.service';
import { AcademiesService } from '../src/academy/services/academies.service';
import { PublicWebsiteCacheService } from '../src/public-website/services/public-website-cache.service';

const BASE = 'slugmove.test';
const MIGRATION = resolvePath(
  __dirname,
  '../prisma/migrations/20261123000000_subdomain_aliases/migration.sql',
);
const PASSWORD = 'correct-horse-battery';

/** A fresh, valid, unreserved label (≤ 50 characters). */
function label(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

describe('Academy address change (e2e) — move + old address redirects', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let tenancy: TenancyContextService;
  let links: LinkBuilderService;

  beforeAll(async () => {
    const saved = process.env.PLATFORM_BASE_DOMAIN;
    process.env.PLATFORM_BASE_DOMAIN = BASE;
    const testApp = await createTestApp();
    if (saved === undefined) delete process.env.PLATFORM_BASE_DOMAIN;
    else process.env.PLATFORM_BASE_DOMAIN = saved;
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    tenancy = app.get(TenancyContextService, { strict: false });
    links = app.get(LinkBuilderService, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());

  async function signUp(name: string) {
    const email = uniqueTestEmail(name);
    await http()
      .post('/auth/register')
      .send({ name, email, password: PASSWORD })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      accessToken: signIn.body.accessToken as string,
    };
  }

  /** A user who only appears in a database context (no sign-in, so no register rate limit). */
  async function fixtureUser(name: string) {
    const user = await fixtureUsers().create({
      data: { email: uniqueTestEmail(name), name },
    });
    return { userId: user.id, accessToken: '' };
  }

  /** An organization owner with one academy whose allocation is its slug. */
  async function arrangeAcademy(name: string, options: { signIn?: boolean } = {}) {
    const owner = options.signIn === false ? await fixtureUser(name) : await signUp(name);
    const org = await seedOrganizationWithOwner(admin, owner.userId, name);
    await seedActiveSubscriptionForOrg(admin, org.id, org.slug);
    const seeded = await seedAcademy(admin, org.id, name);
    const slug = label(name);
    const academy = await admin.academy.update({
      where: { id: seeded.id },
      data: { slug },
    });
    await seedAcademyMember(admin, academy.id, owner.userId);
    await admin.subdomainAllocation.create({
      data: {
        academyId: academy.id,
        subdomain: slug,
        status: 'assigned',
        fullHost: `${slug}.${BASE}`,
      },
    });
    return { owner, org, academy };
  }

  function changeSlug(academyId: string, token: string, slug: string) {
    return http()
      .patch(`/academies/${academyId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ slug });
  }

  function resolve(hostname: string) {
    return http().get('/public/websites/resolve').query({ hostname });
  }

  it('moves the allocation, resolves the new host and redirects the old one', async () => {
    const { owner, org, academy } = await arrangeAcademy('mv-move');
    const oldSlug = academy.slug;
    const newSlug = label('mv-new');

    // Warm the resolution cache on the old host: the change must drop it.
    const before = await resolve(`${oldSlug}.${BASE}`).expect(200);
    expect(before.body).not.toHaveProperty('redirectHost');

    const res = await changeSlug(academy.id, owner.accessToken, newSlug).expect(200);
    expect(res.body.slug).toBe(newSlug);

    const allocation = await admin.subdomainAllocation.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(allocation).toMatchObject({
      subdomain: newSlug,
      fullHost: `${newSlug}.${BASE}`,
      status: 'assigned',
    });
    const aliases = await admin.subdomainAlias.findMany({
      where: { academyId: academy.id },
    });
    expect(aliases.map((row) => row.subdomain)).toEqual([oldSlug]);

    const fresh = await resolve(`${newSlug}.${BASE}`).expect(200);
    expect(fresh.body).toMatchObject({
      academyId: academy.id,
      academySlug: newSlug,
      canonicalHost: `${newSlug}.${BASE}`,
    });
    expect(fresh.body).not.toHaveProperty('redirectHost');

    const old = await resolve(`${oldSlug}.${BASE}`).expect(200);
    expect(old.body).toMatchObject({
      academyId: academy.id,
      canonicalHost: `${newSlug}.${BASE}`,
      redirectHost: `${newSlug}.${BASE}`,
    });

    // The dashboard's address (and so the invite link) follows the move.
    const domain = await http()
      .get(`/academies/${academy.id}/website/domain`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(JSON.stringify(domain.body)).toContain(`${newSlug}.${BASE}`);
    expect(JSON.stringify(domain.body)).not.toContain(`${oldSlug}.${BASE}`);

    // Email links use the new address.
    const hosts = await tenancy.runInTenantAndUserContext(
      org.id,
      owner.userId,
      async (tx) => ({
        canonical: await links.academyHost(tx, academy.id),
        atlas: await links.academyAtlasHost(tx, academy.id),
      }),
    );
    expect(hosts).toEqual({
      canonical: `${newSlug}.${BASE}`,
      atlas: `${newSlug}.${BASE}`,
    });

    // Audited in the domains category, visible to the academy.
    const entry = await admin.auditLogEntry.findFirst({
      where: { academyId: academy.id, action: 'domain.subdomain_changed' },
    });
    expect(entry).toMatchObject({
      actorUserId: owner.userId,
      targetType: 'subdomain_allocation',
      targetLabel: `${newSlug}.${BASE}`,
    });
    expect(entry?.context).toMatchObject({
      previousSubdomain: oldSlug,
      newSubdomain: newSlug,
      redirectKept: true,
    });
  });

  it('a redirect from an old address names the connected custom domain when it is canonical', async () => {
    const { owner, academy } = await arrangeAcademy('mv-custom');
    const oldSlug = academy.slug;
    const customHost = `${label('learn')}.example.test`;
    await admin.domainConnection.create({
      data: { academyId: academy.id, hostname: customHost, status: 'connected' },
    });

    await changeSlug(academy.id, owner.accessToken, label('mv-cnew')).expect(200);

    const old = await resolve(`${oldSlug}.${BASE}`).expect(200);
    expect(old.body.redirectHost).toBe(customHost);
    // The custom domain itself keeps serving, with no redirect.
    const custom = await resolve(customHost).expect(200);
    expect(custom.body).not.toHaveProperty('redirectHost');
  });

  it('another academy cannot take an old address — API and database', async () => {
    const first = await arrangeAcademy('mv-hold');
    const oldSlug = first.academy.slug;
    await changeSlug(first.academy.id, first.owner.accessToken, label('mv-hnew')).expect(
      200,
    );

    const second = await arrangeAcademy('mv-take');

    // API: a slug change, the availability check and a provisioning request.
    const taken = await changeSlug(
      second.academy.id,
      second.owner.accessToken,
      oldSlug,
    ).expect(409);
    expect(taken.body.error.messageKey).toBe('errors.academy.slugTaken');

    const availability = await http()
      .get('/subdomains/availability')
      .query({ subdomain: oldSlug })
      .set('Authorization', `Bearer ${second.owner.accessToken}`)
      .expect(200);
    expect(availability.body).toMatchObject({
      subdomain: oldSlug,
      status: 'unavailable',
    });

    await http()
      .post(`/organizations/${second.org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${second.owner.accessToken}`)
      .send({
        academyName: `Taker ${Date.now()}`,
        requestedSubdomain: oldSlug,
        idempotencyKey: `mv-take-${Date.now()}`,
      })
      .expect(409);

    // Database: every table refuses the label for a different academy, even
    // for a writer that skips the service (superuser and app role alike).
    await expect(
      admin.academy.update({ where: { id: second.academy.id }, data: { slug: oldSlug } }),
    ).rejects.toThrow(/Unique constraint failed/);
    await expect(
      admin.subdomainAllocation.update({
        where: { academyId: second.academy.id },
        data: { subdomain: oldSlug },
      }),
    ).rejects.toThrow(/Unique constraint failed/);
    await expect(
      admin.subdomainAlias.create({
        data: { academyId: second.academy.id, subdomain: oldSlug },
      }),
    ).rejects.toThrow(/Unique constraint failed/);
    // The app role sees the trigger's refusal as an ordinary unique
    // violation (P2002) — the error the service turns into a clean 409.
    const appRoleError = await tenancy
      .runInTenantAndUserContext(second.org.id, second.owner.userId, (tx) =>
        tx.academy.update({ where: { id: second.academy.id }, data: { slug: oldSlug } }),
      )
      .catch((error: unknown) => error);
    expect(appRoleError).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((appRoleError as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');

    // A new academy cannot be created on it either (the one creation path,
    // which the provisioning worker calls).
    await expect(
      app.get(AcademiesService, { strict: false }).create(second.owner.userId, {
        organizationId: second.org.id,
        name: `Taker ${Date.now()}`,
        slug: oldSlug,
      } as never),
    ).rejects.toMatchObject({
      response: { messageKey: 'errors.academy.slugTaken' },
    });
  });

  it('changing back to an old address makes it the address again', async () => {
    const { owner, academy } = await arrangeAcademy('mv-back');
    const original = academy.slug;
    const interim = label('mv-mid');

    await changeSlug(academy.id, owner.accessToken, interim).expect(200);
    await resolve(`${interim}.${BASE}`).expect(200); // cache the live answer
    const back = await changeSlug(academy.id, owner.accessToken, original).expect(200);
    expect(back.body.slug).toBe(original);

    const allocation = await admin.subdomainAllocation.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(allocation).toMatchObject({
      subdomain: original,
      fullHost: `${original}.${BASE}`,
    });
    const aliases = await admin.subdomainAlias.findMany({
      where: { academyId: academy.id },
    });
    expect(aliases.map((row) => row.subdomain)).toEqual([interim]);

    const live = await resolve(`${original}.${BASE}`).expect(200);
    expect(live.body).not.toHaveProperty('redirectHost');
    expect(live.body.academySlug).toBe(original);
    const moved = await resolve(`${interim}.${BASE}`).expect(200);
    expect(moved.body.redirectHost).toBe(`${original}.${BASE}`);

    // Re-saving the settings with the unchanged slug moves nothing.
    await changeSlug(academy.id, owner.accessToken, original).expect(200);
    expect(await admin.subdomainAlias.count({ where: { academyId: academy.id } })).toBe(
      1,
    );
  });

  it('only the organization owner can change the address', async () => {
    const { org, academy } = await arrangeAcademy('mv-mgr');
    const manager = await signUp('mv-mgr-staff');
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: manager.userId, role: 'manager' },
    });
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');

    await changeSlug(academy.id, manager.accessToken, label('mv-mnew')).expect(403);
    const allocation = await admin.subdomainAllocation.findUniqueOrThrow({
      where: { academyId: academy.id },
    });
    expect(allocation.subdomain).toBe(academy.slug);
  });

  it('keeps the reserved-label guard: refused as a new address, never kept as an alias', async () => {
    const { owner, academy } = await arrangeAcademy('mv-rsv');

    const refused = await changeSlug(academy.id, owner.accessToken, 'help').expect(409);
    expect(refused.body.error.messageKey).toBe('errors.academy.slugReserved');

    await expect(
      admin.subdomainAlias.create({ data: { academyId: academy.id, subdomain: 'docs' } }),
    ).rejects.toThrow(/reserved for Atlas/);

    // An academy that held a now-reserved label (written with the guards
    // off, as before DL-57) gives it back to the platform when it moves.
    const legacy = `docs${Date.now()}`;
    await admin.$transaction([
      admin.$executeRawUnsafe(
        'ALTER TABLE academies DISABLE TRIGGER academies_reserved_slug',
      ),
      admin.$executeRawUnsafe(
        'ALTER TABLE subdomain_allocations DISABLE TRIGGER subdomain_allocations_reserved_label',
      ),
      admin.academy.update({ where: { id: academy.id }, data: { slug: legacy } }),
      admin.subdomainAllocation.update({
        where: { academyId: academy.id },
        data: { subdomain: legacy, fullHost: `${legacy}.${BASE}` },
      }),
      admin.$executeRawUnsafe(
        'ALTER TABLE academies ENABLE TRIGGER academies_reserved_slug',
      ),
      admin.$executeRawUnsafe(
        'ALTER TABLE subdomain_allocations ENABLE TRIGGER subdomain_allocations_reserved_label',
      ),
    ]);

    const next = label('mv-rnew');
    await changeSlug(academy.id, owner.accessToken, next).expect(200);
    expect(
      (
        await admin.subdomainAllocation.findUniqueOrThrow({
          where: { academyId: academy.id },
        })
      ).subdomain,
    ).toBe(next);
    expect(await admin.subdomainAlias.count({ where: { academyId: academy.id } })).toBe(
      0,
    );
    await resolve(`${legacy}.${BASE}`).expect(404);
  });

  it('the migration repairs an academy the defect already hit, and a second run changes nothing', async () => {
    // Before the fix: the slug changed, the allocation kept the old label.
    const { academy } = await arrangeAcademy('mv-fill', { signIn: false });
    const stale = label('mv-stale');
    await admin.subdomainAllocation.update({
      where: { academyId: academy.id },
      data: { subdomain: stale, fullHost: `${stale}.${BASE}` },
    });
    // A row the backfill must leave alone: a now-reserved slug.
    const legacy = await arrangeAcademy('mv-fill-rsv', { signIn: false });
    const reservedSlug = `docs${Date.now()}`;
    await admin.$transaction([
      admin.$executeRawUnsafe(
        'ALTER TABLE academies DISABLE TRIGGER academies_reserved_slug',
      ),
      admin.academy.update({
        where: { id: legacy.academy.id },
        data: { slug: reservedSlug },
      }),
      admin.$executeRawUnsafe(
        'ALTER TABLE academies ENABLE TRIGGER academies_reserved_slug',
      ),
    ]);

    const run = () =>
      spawnSync(
        'npx',
        [
          'prisma',
          'db',
          'execute',
          '--file',
          MIGRATION,
          '--schema',
          'prisma/schema.prisma',
        ],
        { cwd: resolvePath(__dirname, '..'), encoding: 'utf8', env: process.env },
      );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = run();
      expect({ status: result.status, stderr: result.stderr }).toMatchObject({
        status: 0,
      });

      expect(
        await admin.subdomainAllocation.findUniqueOrThrow({
          where: { academyId: academy.id },
        }),
      ).toMatchObject({ subdomain: academy.slug, fullHost: `${academy.slug}.${BASE}` });
      expect(
        (await admin.subdomainAlias.findMany({ where: { academyId: academy.id } })).map(
          (row) => row.subdomain,
        ),
      ).toEqual([stale]);
      expect(
        (
          await admin.subdomainAllocation.findUniqueOrThrow({
            where: { academyId: legacy.academy.id },
          })
        ).subdomain,
      ).toBe(legacy.academy.slug);
      expect(
        await admin.subdomainAlias.count({ where: { academyId: legacy.academy.id } }),
      ).toBe(0);
    }

    await app
      .get(PublicWebsiteCacheService, { strict: false })
      .invalidateHostnameResolution([`${stale}.${BASE}`]);
    const old = await resolve(`${stale}.${BASE}`).expect(200);
    expect(old.body.redirectHost).toBe(`${academy.slug}.${BASE}`);
  });

  describe('RLS — subdomain_aliases', () => {
    it('is invisible and unwritable from another organization, and never deletable', async () => {
      const victim = await arrangeAcademy('mv-rls-a');
      await changeSlug(
        victim.academy.id,
        victim.owner.accessToken,
        label('mv-rls-n'),
      ).expect(200);
      const alias = await admin.subdomainAlias.findFirstOrThrow({
        where: { academyId: victim.academy.id },
      });
      const attacker = await arrangeAcademy('mv-rls-b', { signIn: false });

      const seen = await tenancy.runInTenantAndUserContext(
        attacker.org.id,
        attacker.owner.userId,
        (tx) => tx.subdomainAlias.findMany({ where: { academyId: victim.academy.id } }),
      );
      expect(seen).toEqual([]);

      await expect(
        tenancy.runInTenantAndUserContext(attacker.org.id, attacker.owner.userId, (tx) =>
          tx.subdomainAlias.create({
            data: { academyId: victim.academy.id, subdomain: label('mv-hijack') },
          }),
        ),
      ).rejects.toThrow(/row-level security policy/i);

      const updated = await tenancy.runInTenantAndUserContext(
        attacker.org.id,
        attacker.owner.userId,
        (tx) =>
          tx.subdomainAlias.updateMany({
            where: { id: alias.id },
            data: { subdomain: label('mv-steal') },
          }),
      );
      expect(updated.count).toBe(0);

      // Its own owner sees it, but no one can delete it (no DELETE policy).
      const own = await tenancy.runInTenantAndUserContext(
        victim.org.id,
        victim.owner.userId,
        async (tx) => ({
          rows: await tx.subdomainAlias.findMany({
            where: { academyId: victim.academy.id },
          }),
          deleted: await tx.subdomainAlias.deleteMany({ where: { id: alias.id } }),
        }),
      );
      expect(own.rows.map((row) => row.id)).toEqual([alias.id]);
      expect(own.deleted.count).toBe(0);
      expect(await admin.subdomainAlias.count({ where: { id: alias.id } })).toBe(1);
    });

    it('is invisible to a member of another academy in the same organization', async () => {
      const { owner, org, academy } = await arrangeAcademy('mv-rls-c');
      await changeSlug(academy.id, owner.accessToken, label('mv-rls-m')).expect(200);
      const sibling = await seedAcademy(admin, org.id, 'mv-rls-sib');
      const manager = await fixtureUser('mv-rls-sib-mgr');
      await admin.organizationMembership.create({
        data: { organizationId: org.id, userId: manager.userId, role: 'manager' },
      });
      await seedAcademyMember(admin, sibling.id, manager.userId, 'manager');

      const seen = await tenancy.runInTenantAndUserContext(org.id, manager.userId, (tx) =>
        tx.subdomainAlias.findMany({ where: { academyId: academy.id } }),
      );
      expect(seen).toEqual([]);
    });
  });
});
