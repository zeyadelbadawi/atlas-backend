/**
 * U-14d / OD-21 — the lost-response recovery record. The database side
 * (direct, unused, live successor) is proven end to end by
 * `test/auth-refresh-lost-response.e2e-spec.ts`; this pins the record itself:
 * only the presenter of the retired token can open it, only the same client
 * matches, nothing usable sits in Redis, and Redis trouble fails closed.
 */
import {
  RefreshReissueService,
  type ReissueClientBinding,
} from './refresh-reissue.service';
import { generateOpaqueToken, hashOpaqueToken } from '../utils/opaque-token.util';
import type { RedisService } from '../../redis/redis.service';

function fakeRedis(overrides: Partial<{ set: jest.Mock; get: jest.Mock }> = {}) {
  const store = new Map<string, { value: string; ttl: number }>();
  const client = {
    set: jest.fn(async (key: string, value: string, _ex: string, ttl: number) => {
      store.set(key, { value, ttl });
      return 'OK';
    }),
    get: jest.fn(async (key: string) => store.get(key)?.value ?? null),
    ...overrides,
  };
  return {
    store,
    client,
    service: new RefreshReissueService({
      getClient: () => client,
    } as unknown as RedisService),
  };
}

const BROWSER: ReissueClientBinding = {
  channel: 'cookie',
  userAgent: 'Mozilla/5.0 fixture',
  deviceCookie: 'device-fixture',
  hostname: 'academy.example.test',
};

describe('RefreshReissueService', () => {
  const presented = generateOpaqueToken();
  const presentedHash = hashOpaqueToken(presented);
  const successor = generateOpaqueToken();

  it('hands the successor back to the same client, for the window only', async () => {
    const { service, store } = fakeRedis();
    await service.remember(presented, presentedHash, successor, BROWSER, 30);
    expect([...store.values()][0].ttl).toBe(30);
    await expect(service.lookup(presented, presentedHash, BROWSER)).resolves.toEqual({
      kind: 'successor',
      successorToken: successor,
    });
    // Host comparison is case-insensitive, like hostnames.
    await expect(
      service.lookup(presented, presentedHash, {
        ...BROWSER,
        hostname: 'ACADEMY.example.test',
      }),
    ).resolves.toMatchObject({ kind: 'successor' });
  });

  it('stores nothing usable: no raw token, no raw client values', async () => {
    const { service, store } = fakeRedis();
    await service.remember(presented, presentedHash, successor, BROWSER, 30);
    const [[key, { value }]] = [...store.entries()];
    expect(key).toBe(`refresh:reissue:${presentedHash}`);
    for (const secret of [
      presented,
      successor,
      BROWSER.userAgent!,
      BROWSER.deviceCookie!,
    ]) {
      expect(value).not.toContain(secret);
    }
  });

  it.each<[string, Partial<ReissueClientBinding>]>([
    ['another User-Agent', { userAgent: 'curl/8' }],
    ['no User-Agent', { userAgent: undefined }],
    ['another device cookie', { deviceCookie: 'other-device' }],
    ['another host', { hostname: 'other.example.test' }],
    ['the token moved into a body', { channel: 'body' }],
  ])('%s is a foreign client', async (_label, change) => {
    const { service } = fakeRedis();
    await service.remember(presented, presentedHash, successor, BROWSER, 30);
    await expect(
      service.lookup(presented, presentedHash, { ...BROWSER, ...change }),
    ).resolves.toEqual({ kind: 'foreign' });
  });

  it('a record can only be opened with the retired token itself; a tampered one is ignored', async () => {
    const { service, store } = fakeRedis();
    await service.remember(presented, presentedHash, successor, BROWSER, 30);
    // The right key, the wrong token (e.g. someone holding only the hash).
    await expect(
      service.lookup(generateOpaqueToken(), presentedHash, BROWSER),
    ).resolves.toEqual({
      kind: 'none',
    });
    // A swapped client digest no longer authenticates: ignored, not "foreign".
    const key = `refresh:reissue:${presentedHash}`;
    const record = JSON.parse(store.get(key)!.value);
    store.set(key, { value: JSON.stringify({ ...record, b: 'f'.repeat(64) }), ttl: 30 });
    await expect(service.lookup(presented, presentedHash, BROWSER)).resolves.toEqual({
      kind: 'none',
    });
    store.set(key, { value: 'not json', ttl: 30 });
    await expect(service.lookup(presented, presentedHash, BROWSER)).resolves.toEqual({
      kind: 'none',
    });
  });

  it('records nothing for a body refresh or with the window off', async () => {
    const { service, client } = fakeRedis();
    await service.remember(
      presented,
      presentedHash,
      successor,
      { ...BROWSER, channel: 'body' },
      30,
    );
    await service.remember(presented, presentedHash, successor, BROWSER, 0);
    expect(client.set).not.toHaveBeenCalled();
    await expect(service.lookup(presented, presentedHash, BROWSER)).resolves.toEqual({
      kind: 'none',
    });
  });

  it('fails closed and fast when Redis errors or hangs', async () => {
    const hanging = fakeRedis({
      set: jest.fn(() => new Promise(() => undefined)),
      get: jest.fn(() => new Promise(() => undefined)),
    });
    const started = Date.now();
    await expect(
      hanging.service.remember(presented, presentedHash, successor, BROWSER, 30),
    ).resolves.toBeUndefined();
    await expect(
      hanging.service.lookup(presented, presentedHash, BROWSER),
    ).resolves.toEqual({
      kind: 'none',
    });
    expect(Date.now() - started).toBeLessThan(2000);

    const failing = fakeRedis({
      set: jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      get: jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    await expect(
      failing.service.remember(presented, presentedHash, successor, BROWSER, 30),
    ).resolves.toBeUndefined();
    await expect(
      failing.service.lookup(presented, presentedHash, BROWSER),
    ).resolves.toEqual({
      kind: 'none',
    });
  });
});
