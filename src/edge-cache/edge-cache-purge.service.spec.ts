/**
 * EdgeCachePurgeService — what it sends to Cloudflare and when, against a
 * mocked `fetch` and fake timers. No network.
 */
import { of } from 'rxjs';
import {
  BLOG_EDGE_TAG,
  EdgeCachePurgeService,
  academyEdgeTag,
  hostEdgeTag,
} from './edge-cache-purge.service';
import {
  PurgeAcademyEdgeCacheInterceptor,
  SKIP_ACADEMY_EDGE_PURGE,
} from './purge-academy-edge-cache.interceptor';
import { WebsiteController } from '../website/controllers/website.controller';

const ZONE = 'a'.repeat(32);
const ACADEMY = '11111111-2222-4333-8444-555555555555';

type Call = { url: string; auth?: string; tags: string[] };

function build({
  token = 'purge-token',
  status = 200,
  success = true,
  academies = [] as { id: string }[],
} = {}) {
  const calls: Call[] = [];
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      auth: (init?.headers as Record<string, string>)?.Authorization,
      tags: JSON.parse(String(init?.body)).tags,
    });
    return {
      ok: status < 300,
      status,
      json: async () => ({ success, errors: [] }),
    } as Response;
  }) as never;
  const tenancy = {
    runInTenantContext: jest.fn(async (_org: string, work: (tx: unknown) => unknown) =>
      work({ academy: { findMany: async () => academies } }),
    ),
  };
  const service = new EdgeCachePurgeService(
    { get: () => ({ cachePurgeToken: token || undefined, zoneId: ZONE }) } as never,
    tenancy as never,
  );
  return { service, calls, tenancy };
}

async function advance(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
}

describe('EdgeCachePurgeService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    // @ts-expect-error restore
    delete global.fetch;
  });

  it('purges an Academy by its tag after a short delay, with the purge token', async () => {
    const { service, calls } = build();
    service.purgeAcademy(ACADEMY);
    expect(calls).toHaveLength(0);
    await advance(1_500);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://api.cloudflare.com/client/v4/zones/${ZONE}/purge_cache`,
    );
    expect(calls[0].auth).toBe('Bearer purge-token');
    expect(calls[0].tags).toEqual([`atlas-academy-${ACADEMY}`]);
    service.onModuleDestroy();
  });

  it('B3: purges the marketing blog by its own tag, twice like every purge', async () => {
    const { service, calls } = build();
    expect(BLOG_EDGE_TAG).toBe('atlas-blog');
    service.purgeBlog();
    service.purgeBlog();
    await advance(1_500);
    expect(calls).toHaveLength(1);
    expect(calls[0].tags).toEqual(['atlas-blog']);
    await advance(30_000);
    expect(calls).toHaveLength(2);
    expect(calls[1].tags).toEqual(['atlas-blog']);
    service.onModuleDestroy();
  });

  it('B3: a blog purge is a no-op without a purge token', async () => {
    const { service, calls } = build({ token: '' });
    service.purgeBlog();
    await advance(60_000);
    expect(calls).toHaveLength(0);
    service.onModuleDestroy();
  });

  it('coalesces a burst into one request, and purges it once more a little later', async () => {
    const { service, calls } = build();
    service.purgeAcademy(ACADEMY);
    service.purgeAcademy(ACADEMY);
    service.purgeHosts(['Learn.Example.com.', 'my.atlass.dpdns.org']);
    await advance(1_500);
    expect(calls).toHaveLength(1);
    expect(calls[0].tags.sort()).toEqual(
      [
        academyEdgeTag(ACADEMY),
        'atlas-host-learn.example.com',
        'atlas-host-my.atlass.dpdns.org',
      ].sort(),
    );
    await advance(15_000);
    expect(calls).toHaveLength(2);
    expect(calls[1].tags.sort()).toEqual(calls[0].tags.sort());
    service.onModuleDestroy();
  });

  it('sends at most one request per 12 seconds', async () => {
    const { service, calls } = build();
    service.purgeAcademy(ACADEMY);
    await advance(1_500);
    service.purgeHosts(['a.atlass.dpdns.org']);
    await advance(5_000);
    expect(calls).toHaveLength(1);
    await advance(7_000);
    expect(calls).toHaveLength(2);
    expect(calls[1].tags).toEqual([hostEdgeTag('a.atlass.dpdns.org')]);
    service.onModuleDestroy();
  });

  it('purges every Academy of an Organization', async () => {
    const { service, calls, tenancy } = build({
      academies: [{ id: 'x1' }, { id: 'x2' }],
    });
    await service.purgeOrganization('org-1');
    expect(tenancy.runInTenantContext).toHaveBeenCalledWith(
      'org-1',
      expect.any(Function),
    );
    await advance(1_500);
    expect(calls[0].tags.sort()).toEqual(['atlas-academy-x1', 'atlas-academy-x2']);
    service.onModuleDestroy();
  });

  it('does nothing without a purge token', async () => {
    const { service, calls, tenancy } = build({ token: '' });
    expect(service.enabled).toBe(false);
    service.purgeAcademy(ACADEMY);
    await service.purgeOrganization('org-1');
    await advance(30_000);
    expect(calls).toHaveLength(0);
    expect(tenancy.runInTenantContext).not.toHaveBeenCalled();
  });

  it('keeps rate-limited tags for the next slot, and never throws on a refusal', async () => {
    const { service, calls } = build({ status: 429, success: false });
    service.purgeAcademy(ACADEMY);
    await advance(1_500);
    expect(calls).toHaveLength(1);
    await advance(12_000);
    expect(calls).toHaveLength(2);
    expect(calls[1].tags).toEqual([academyEdgeTag(ACADEMY)]);
    service.onModuleDestroy();
  });
});

describe('PurgeAcademyEdgeCacheInterceptor', () => {
  function run(method: string, params: Record<string, string>, skip = false) {
    const purgeAcademy = jest.fn();
    const interceptor = new PurgeAcademyEdgeCacheInterceptor(
      { purgeAcademy } as never,
      { get: () => skip } as never,
    );
    const context = {
      getType: () => 'http',
      getHandler: () => () => undefined,
      switchToHttp: () => ({ getRequest: () => ({ method, params }) }),
    };
    let emitted = false;
    interceptor
      .intercept(context as never, { handle: () => of('ok') })
      .subscribe(() => (emitted = true));
    return { purgeAcademy, emitted };
  }

  it('purges the route Academy after a successful write', () => {
    const { purgeAcademy, emitted } = run('PATCH', { id: ACADEMY, courseId: 'c' });
    expect(emitted).toBe(true);
    expect(purgeAcademy).toHaveBeenCalledWith(ACADEMY);
  });

  it('ignores reads, skipped handlers and routes without an Academy id', () => {
    expect(run('GET', { id: ACADEMY }).purgeAcademy).not.toHaveBeenCalled();
    expect(run('POST', { id: ACADEMY }, true).purgeAcademy).not.toHaveBeenCalled();
    expect(run('POST', { id: 'not-a-uuid' }).purgeAcademy).not.toHaveBeenCalled();
    expect(run('POST', {}).purgeAcademy).not.toHaveBeenCalled();
  });
});

describe('website draft writes', () => {
  const skips = (handler: keyof WebsiteController) =>
    Reflect.getMetadata(SKIP_ACADEMY_EDGE_PURGE, WebsiteController.prototype[handler]) ===
    true;

  it('do not purge: a page draft is not what a visitor sees', () => {
    for (const handler of ['createPage', 'updatePage', 'reorderSections'] as const) {
      expect(skips(handler)).toBe(true);
    }
  });

  it('publishing, and anything else that changes the public site, still purges', () => {
    for (const handler of [
      'publish',
      'unpublish',
      'publishPage',
      'deletePage',
      'updateConfiguration',
      'saveVisualIdentity',
    ] as const) {
      expect(skips(handler)).toBe(false);
    }
  });
});
