/**
 * Every absolute URL an Atlas email carries is built here, and the two
 * things that can go wrong are both invisible until a real person clicks:
 *
 *  1. A HOST TAKEN FROM A REQUEST. Emails are rendered by a worker that has
 *     no request at all, and a `Host`/`X-Forwarded-Host` header is
 *     attacker-controlled — a link built from one is a password-reset link
 *     pointing at the attacker's domain. This spec pins the shape of the
 *     API that makes that impossible: the host comes from configuration
 *     (platform links) or from the academy's own rows under the canonical-
 *     host rule (academy links), and no method accepts a request, headers
 *     or a host string from a caller.
 *  2. A MALFORMED URL. A trailing slash in `PLATFORM_WEB_URL` plus a leading
 *     slash in a catalogue path yields `https://host//dashboard`, and a
 *     missing `/ar` prefix drops an Arabic reader onto the English router.
 *
 * Nothing here touches Postgres: the transaction client is a stub, which is
 * exactly the point — the resolution rule is pure.
 */
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../database/prisma.service';
import { LinkBuilderService } from './link-builder.service';

const PLATFORM_URL = 'https://app.atlas.test';

interface HostRows {
  readonly allocation?: { fullHost?: string | null; subdomain?: string | null } | null;
  readonly connection?: {
    status?: string;
    hostname?: string | null;
    httpsReachable?: boolean | null;
  } | null;
}

function txStub(rows: HostRows): Prisma.TransactionClient {
  return {
    subdomainAllocation: { findUnique: async () => rows.allocation ?? null },
    domainConnection: { findUnique: async () => rows.connection ?? null },
  } as unknown as Prisma.TransactionClient;
}

function configStub(
  platformWebUrl: string,
  baseDomain: string | undefined,
): ConfigService {
  return {
    getOrThrow: (key: string) => {
      if (key === 'communications') return { platformWebUrl, platformName: 'Atlas' };
      throw new Error(`Unexpected config key: ${key}`);
    },
    get: (key: string) => (key === 'platformDomain' ? { baseDomain } : undefined),
  } as unknown as ConfigService;
}

function prismaStub(baseDomain: string | null): {
  prisma: PrismaService;
  calls: () => number;
} {
  let calls = 0;
  const prisma = {
    platformDomainConfiguration: {
      findFirst: async () => {
        calls += 1;
        return baseDomain ? { baseDomain } : null;
      },
    },
  } as unknown as PrismaService;
  return { prisma, calls: () => calls };
}

function build(
  options: {
    platformWebUrl?: string;
    envBaseDomain?: string;
    dbBaseDomain?: string | null;
  } = {},
) {
  const { prisma, calls } = prismaStub(options.dbBaseDomain ?? null);
  const service = new LinkBuilderService(
    configStub(options.platformWebUrl ?? PLATFORM_URL, options.envBaseDomain),
    prisma,
  );
  return { service, platformDomainReads: calls };
}

describe('LinkBuilderService', () => {
  describe('platform links', () => {
    it('joins the configured platform URL and the path with exactly one slash', () => {
      const { service } = build();
      expect(service.platform('/dashboard/billing')).toBe(
        `${PLATFORM_URL}/dashboard/billing`,
      );
    });

    it('adds the missing leading slash of a relative path', () => {
      const { service } = build();
      expect(service.platform('dashboard')).toBe(`${PLATFORM_URL}/dashboard`);
    });

    it('never produces a double slash, whatever the configured URL ends with', () => {
      const { service } = build({ platformWebUrl: `${PLATFORM_URL}///` });
      for (const path of ['/dashboard', 'dashboard', '/', '']) {
        const url = service.platform(path);
        expect(url.startsWith(`${PLATFORM_URL}/`)).toBe(true);
        expect(url.slice('https://'.length)).not.toContain('//');
      }
    });

    it('defaults to the site root when called with no path', () => {
      const { service } = build();
      expect(service.platform()).toBe(`${PLATFORM_URL}/`);
    });
  });

  describe('settings link', () => {
    it('uses the platform host with no prefix for English when no academy host is known', () => {
      const { service } = build();
      expect(service.settings('en', null)).toBe(`${PLATFORM_URL}/settings/notifications`);
    });

    it('prefixes `/ar` for Arabic', () => {
      const { service } = build();
      expect(service.settings('ar', null)).toBe(
        `${PLATFORM_URL}/ar/settings/notifications`,
      );
    });

    it('uses the academy host, over https, when one is known', () => {
      const { service } = build();
      expect(service.settings('en', 'falcon.atlas.test')).toBe(
        'https://falcon.atlas.test/settings/notifications',
      );
      expect(service.settings('ar', 'falcon.atlas.test')).toBe(
        'https://falcon.atlas.test/ar/settings/notifications',
      );
    });
  });

  describe('academy host (the canonical-host rule, P63)', () => {
    it('prefers a connected, reachable custom domain', async () => {
      const { service } = build();
      const host = await service.academyHost(
        txStub({
          allocation: { fullHost: 'falcon.atlas.test' },
          connection: {
            status: 'connected',
            hostname: 'Falcon.Example.COM',
            httpsReachable: true,
          },
        }),
        'academy-1',
      );
      expect(host).toBe('falcon.example.com');
    });

    it('falls back to the subdomain when the custom domain is not connected', async () => {
      const { service } = build();
      const host = await service.academyHost(
        txStub({
          allocation: { fullHost: 'falcon.atlas.test' },
          connection: { status: 'pending_dns', hostname: 'falcon.example.com' },
        }),
        'academy-1',
      );
      expect(host).toBe('falcon.atlas.test');
    });

    it('demotes a connected custom domain whose HTTPS probe failed', async () => {
      const { service } = build();
      const host = await service.academyHost(
        txStub({
          allocation: { fullHost: 'falcon.atlas.test' },
          connection: {
            status: 'connected',
            hostname: 'falcon.example.com',
            httpsReachable: false,
          },
        }),
        'academy-1',
      );
      expect(host).toBe('falcon.atlas.test');
    });

    it('composes the subdomain from the configured base domain when the allocation has no full host', async () => {
      const { service } = build({ envBaseDomain: 'atlas.test' });
      const host = await service.academyHost(
        txStub({ allocation: { subdomain: 'Falcon' } }),
        'academy-1',
      );
      expect(host).toBe('falcon.atlas.test');
    });

    it('reads the stored base domain only when the environment configures none', async () => {
      const configured = build({ envBaseDomain: 'atlas.test' });
      await configured.service.academyHost(
        txStub({ allocation: { subdomain: 'falcon' } }),
        'academy-1',
      );
      expect(configured.platformDomainReads()).toBe(0);

      const fromDb = build({ envBaseDomain: undefined, dbBaseDomain: 'Stored.Test' });
      const host = await fromDb.service.academyHost(
        txStub({ allocation: { subdomain: 'falcon' } }),
        'academy-1',
      );
      expect(fromDb.platformDomainReads()).toBe(1);
      expect(host).toBe('falcon.stored.test');
    });

    it('returns null — never a fabricated host — when the academy has none', async () => {
      const { service } = build({ envBaseDomain: undefined, dbBaseDomain: null });
      expect(await service.academyHost(txStub({}), 'academy-1')).toBeNull();
    });
  });

  describe('academy links', () => {
    it('prefixes `/ar` for Arabic and nothing for English', async () => {
      const { service } = build();
      const rows = txStub({ allocation: { fullHost: 'falcon.atlas.test' } });
      expect(await service.academy(rows, 'academy-1', '/my/certificates', 'en')).toBe(
        'https://falcon.atlas.test/my/certificates',
      );
      expect(await service.academy(rows, 'academy-1', '/my/certificates', 'ar')).toBe(
        'https://falcon.atlas.test/ar/my/certificates',
      );
    });

    it('falls back to the platform URL (still locale-prefixed) when the academy has no host', async () => {
      const { service } = build({ envBaseDomain: undefined, dbBaseDomain: null });
      expect(
        await service.academy(txStub({}), 'academy-1', '/my/certificates', 'ar'),
      ).toBe(`${PLATFORM_URL}/ar/my/certificates`);
    });

    it('`onHost` builds from an already-resolved host without re-reading anything', () => {
      const { service, platformDomainReads } = build();
      expect(service.onHost('falcon.atlas.test', 'my/certificates', 'ar')).toBe(
        'https://falcon.atlas.test/ar/my/certificates',
      );
      expect(service.onHost(null, '/my/certificates', 'en')).toBe(
        `${PLATFORM_URL}/my/certificates`,
      );
      expect(platformDomainReads()).toBe(0);
    });
  });

  describe('no request is ever consulted', () => {
    it('exposes no method that accepts a request, headers or a caller-supplied host', () => {
      // `onHost` takes a host, but only one this service itself resolved —
      // its caller (the dispatcher) gets it from `academyHost`/branding,
      // never from a client. Everything else is (path[, locale]) or
      // (tx, academyId, ...): there is no parameter a request could reach.
      expect(LinkBuilderService.prototype.platform.length).toBe(0); // (path = '/')
      expect(LinkBuilderService.prototype.settings.length).toBe(2); // (locale, academyHost)
      expect(LinkBuilderService.prototype.academyHost.length).toBe(2); // (tx, academyId)
      expect(LinkBuilderService.prototype.academy.length).toBe(4); // (tx, academyId, path, locale)
      expect(LinkBuilderService.prototype.onHost.length).toBe(3); // (host, path, locale)
    });

    it('produces the same link for the same academy no matter what is in the environment', async () => {
      const { service } = build();
      const rows = txStub({ allocation: { fullHost: 'falcon.atlas.test' } });
      const before = await service.academy(rows, 'academy-1', '/dashboard', 'en');
      // A poisoned host header would arrive as one of these in a
      // request-scoped design; none of them is an input here.
      process.env.HOST = 'evil.test';
      process.env.X_FORWARDED_HOST = 'evil.test';
      try {
        const after = await service.academy(rows, 'academy-1', '/dashboard', 'en');
        expect(after).toBe(before);
        expect(after).not.toContain('evil.test');
        expect(service.platform('/reset-password')).not.toContain('evil.test');
      } finally {
        delete process.env.HOST;
        delete process.env.X_FORWARDED_HOST;
      }
    });
  });
});
