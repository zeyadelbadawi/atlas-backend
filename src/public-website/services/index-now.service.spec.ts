import { ConfigService } from '@nestjs/config';
import { EdgeCachePurgeService } from '../../edge-cache/edge-cache-purge.service';
import { INDEXNOW_ENDPOINT, IndexNowService } from './index-now.service';
import type { PublicWebsiteService } from './public-website.service';

const ACADEMY = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-06T12:00:00.000Z');

function setup(
  options: {
    enabled?: boolean;
    files?: Partial<Awaited<ReturnType<PublicWebsiteService['getSeoFiles']>>>;
    host?: string | null;
  } = {},
) {
  const config = new ConfigService({
    indexNow: { enabled: options.enabled ?? true, keySecret: 'a-test-secret-of-length' },
  });
  const listeners: Array<(id: string) => void> = [];
  const purge = {
    onAcademyChanged: (listener: (id: string) => void) => listeners.push(listener),
  } as unknown as EdgeCachePurgeService;
  const publicWebsite = {
    getCanonicalHost: jest
      .fn()
      .mockResolvedValue(options.host === undefined ? 'horizon.example' : options.host),
    resolveHostname: jest.fn().mockResolvedValue({ academyId: ACADEMY }),
    getSeoFiles: jest.fn().mockResolvedValue({
      indexable: true,
      sitemapEnabled: true,
      origin: 'https://horizon.example',
      defaultLocale: 'en',
      urls: [
        {
          path: '/',
          lastModified: '2026-11-06T11:30:00.000Z',
          changeFrequency: 'weekly',
          priority: 1,
        },
        {
          path: '/about',
          lastModified: '2026-10-01T00:00:00.000Z',
          changeFrequency: 'monthly',
          priority: 0.6,
        },
        {
          path: '/courses/ux',
          lastModified: '2026-11-06T11:59:00.000Z',
          changeFrequency: 'weekly',
          priority: 0.8,
        },
      ],
      ...options.files,
    }),
  } as unknown as PublicWebsiteService;
  const service = new IndexNowService(config, purge, publicWebsite);
  return { service, listeners, publicWebsite };
}

describe('IndexNowService', () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('derives a stable, per-academy key in the protocol’s format', () => {
    const { service } = setup();
    const key = service.keyFor(ACADEMY);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(service.keyFor(ACADEMY)).toBe(key);
    expect(service.keyFor('22222222-2222-4222-8222-222222222222')).not.toBe(key);
  });

  it('submits only URLs changed recently, in both languages, with the key file location', async () => {
    const { service } = setup();
    const sent = await service.submit(ACADEMY, NOW);
    expect(sent).toEqual([
      'https://horizon.example/',
      'https://horizon.example/ar',
      'https://horizon.example/courses/ux',
      'https://horizon.example/ar/courses/ux',
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(INDEXNOW_ENDPOINT);
    expect(JSON.parse(String(init.body))).toEqual({
      host: 'horizon.example',
      key: service.keyFor(ACADEMY),
      keyLocation: 'https://horizon.example/indexnow-key.txt',
      urlList: sent,
    });
  });

  it('never re-sends a URL that has not changed since the last submission', async () => {
    const { service } = setup();
    await service.submit(ACADEMY, NOW);
    expect(await service.submit(ACADEMY, NOW + 60_000)).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('submits nothing for a site that is not indexable, has no sitemap or no host', async () => {
    for (const options of [
      { files: { indexable: false } },
      { files: { sitemapEnabled: false } },
      { host: null },
    ]) {
      const { service } = setup(options);
      expect(await service.submit(ACADEMY, NOW)).toEqual([]);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never throws when the endpoint fails, and retries those URLs next time', async () => {
    const { service } = setup();
    fetchSpy.mockRejectedValueOnce(new Error('network down'));
    expect(await service.submit(ACADEMY, NOW)).toEqual([]);
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await service.submit(ACADEMY, NOW + 1_000)).toHaveLength(4);
  });

  it('listens for academy changes only when on, and serves no key when off', async () => {
    const on = setup();
    on.service.onModuleInit();
    expect(on.listeners).toHaveLength(1);
    on.service.onModuleDestroy();

    const off = setup({ enabled: false });
    off.service.onModuleInit();
    expect(off.listeners).toHaveLength(0);
    expect(off.service.keyFor(ACADEMY)).toBeNull();
    expect(await off.service.keyFileFor('horizon.example')).toBeNull();
    expect(await off.service.submit(ACADEMY, NOW)).toEqual([]);
  });

  it('serves the key file only for an indexable published site', async () => {
    const { service } = setup();
    expect(await service.keyFileFor('horizon.example')).toBe(service.keyFor(ACADEMY));
    const closed = setup({ files: { indexable: false } });
    expect(await closed.service.keyFileFor('horizon.example')).toBeNull();
  });

  it('coalesces a burst of changes into one submission', () => {
    jest.useFakeTimers();
    try {
      const { service } = setup();
      const submit = jest.spyOn(service, 'submit').mockResolvedValue([]);
      service.notify(ACADEMY);
      service.notify(ACADEMY);
      service.notify(ACADEMY);
      jest.advanceTimersByTime(60_000);
      expect(submit).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('still submits within ten minutes when changes never stop arriving', () => {
    jest.useFakeTimers();
    try {
      const { service } = setup();
      const submit = jest.spyOn(service, 'submit').mockResolvedValue([]);
      // A change every 30 s would postpone a plain debounce forever.
      for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 30_000) {
        service.notify(ACADEMY);
        jest.advanceTimersByTime(30_000);
      }
      expect(submit).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
