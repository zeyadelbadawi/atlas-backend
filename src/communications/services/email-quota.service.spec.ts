/**
 * EmailQuotaService — Redis is stubbed with an in-memory map so every
 * class line is exercised deterministically, offline.
 */
import {
  EmailQuotaService,
  categoryLine,
  dailyKey,
  monthlyKey,
} from './email-quota.service';
import type { RedisService } from '../../redis/redis.service';
import type { CommunicationMetricsService } from './communication-metrics.service';

function memoryRedis() {
  const store = new Map<string, number>();
  const client = {
    incr: jest.fn(async (key: string) => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    }),
    expire: jest.fn().mockResolvedValue(1),
    mget: jest.fn(async (...keys: string[]) =>
      keys.map((k) => (store.has(k) ? String(store.get(k)) : null)),
    ),
  };
  return {
    store,
    client,
    service: { getClient: () => client } as unknown as RedisService,
  };
}

const brevo = {
  dailyLimit: 300,
  monthlyLimit: 9000,
  perSecond: 5,
  supportsWebhooks: true,
  supportsHtml: true,
  supportsIdempotencyKey: false,
};
const unlimited = {
  supportsWebhooks: false,
  supportsHtml: true,
  supportsIdempotencyKey: true,
};

describe('EmailQuotaService', () => {
  const now = new Date('2026-09-24T12:00:00Z');

  it('keys counters by UTC day and month', () => {
    expect(dailyKey('brevo', now)).toBe('comm:quota:brevo:d:20260924');
    expect(monthlyKey('brevo', now)).toBe('comm:quota:brevo:m:202609');
  });

  it('defines the class lines', () => {
    expect(categoryLine('security')).toBe(1);
    expect(categoryLine('transactional')).toBe(1);
    expect(categoryLine('lifecycle')).toBe(0.85);
    expect(categoryLine('engagement')).toBe(0.7);
    expect(categoryLine('operational')).toBe(0.7);
  });

  it('increments both windows on an accepted send and publishes the used ratio', async () => {
    const redis = memoryRedis();
    const setQuotaUsedRatio = jest.fn();
    const service = new EmailQuotaService(redis.service, {
      setQuotaUsedRatio,
    } as unknown as CommunicationMetricsService);

    await service.recordAccepted('brevo', brevo, now);
    await service.recordAccepted('brevo', brevo, now);

    expect(redis.store.get(dailyKey('brevo', now))).toBe(2);
    expect(redis.store.get(monthlyKey('brevo', now))).toBe(2);
    expect(redis.client.expire).toHaveBeenCalledTimes(2); // first increment of each key only
    expect(setQuotaUsedRatio).toHaveBeenLastCalledWith('brevo', 'monthly', 2 / 9000);
    const usage = await service.usage('brevo', brevo, now);
    expect(usage.daily).toEqual({ used: 2, limit: 300, ratio: 2 / 300 });
  });

  it('stops engagement at 70%, lifecycle at 85%, and security only at 100% of the daily budget', async () => {
    const redis = memoryRedis();
    const service = new EmailQuotaService(redis.service, {
      setQuotaUsedRatio: jest.fn(),
    } as unknown as CommunicationMetricsService);

    redis.store.set(dailyKey('brevo', now), 210); // 70% of 300
    expect(await service.reserve('brevo', 'engagement', brevo, now)).toEqual({
      ok: false,
      reason: 'daily',
    });
    expect(await service.reserve('brevo', 'lifecycle', brevo, now)).toEqual({ ok: true });

    redis.store.set(dailyKey('brevo', now), 255); // 85%
    expect(await service.reserve('brevo', 'lifecycle', brevo, now)).toEqual({
      ok: false,
      reason: 'daily',
    });
    expect(await service.reserve('brevo', 'transactional', brevo, now)).toEqual({
      ok: true,
    });

    redis.store.set(dailyKey('brevo', now), 300);
    expect(await service.reserve('brevo', 'security', brevo, now)).toEqual({
      ok: false,
      reason: 'daily',
    });
  });

  it('applies the same lines to the monthly window', async () => {
    const redis = memoryRedis();
    const service = new EmailQuotaService(redis.service, {
      setQuotaUsedRatio: jest.fn(),
    } as unknown as CommunicationMetricsService);
    redis.store.set(monthlyKey('resend', now), 2100); // 70% of 3000
    const resend = { ...brevo, dailyLimit: 100, monthlyLimit: 3000, perSecond: 2 };
    expect(await service.reserve('resend', 'operational', resend, now)).toEqual({
      ok: false,
      reason: 'monthly',
    });
    expect(await service.reserve('resend', 'security', resend, now)).toEqual({
      ok: true,
    });
  });

  it('enforces the per-second window', async () => {
    const redis = memoryRedis();
    const service = new EmailQuotaService(redis.service, {
      setQuotaUsedRatio: jest.fn(),
    } as unknown as CommunicationMetricsService);
    const resend = { ...brevo, perSecond: 2 };
    expect(await service.reserve('resend', 'security', resend, now)).toEqual({
      ok: true,
    });
    expect(await service.reserve('resend', 'security', resend, now)).toEqual({
      ok: true,
    });
    expect(await service.reserve('resend', 'security', resend, now)).toEqual({
      ok: false,
      reason: 'rate',
    });
    const later = new Date(now.getTime() + 1000);
    expect(await service.reserve('resend', 'security', resend, later)).toEqual({
      ok: true,
    });
  });

  it('is unlimited on every axis when the capability is undefined', async () => {
    const redis = memoryRedis();
    const service = new EmailQuotaService(redis.service, {
      setQuotaUsedRatio: jest.fn(),
    } as unknown as CommunicationMetricsService);
    redis.store.set(dailyKey('stub', now), 1_000_000);
    expect(await service.reserve('stub', 'engagement', unlimited, now)).toEqual({
      ok: true,
    });
    expect(redis.client.incr).not.toHaveBeenCalled();
    const usage = await service.usage('stub', unlimited, now);
    expect(usage.daily).toEqual({ used: 1_000_000, limit: undefined, ratio: 0 });
  });

  it('fails open when Redis is unreachable', async () => {
    const broken = {
      getClient: () => ({
        mget: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      }),
    } as unknown as RedisService;
    const service = new EmailQuotaService(broken, {
      setQuotaUsedRatio: jest.fn(),
    } as unknown as CommunicationMetricsService);
    expect(await service.reserve('brevo', 'engagement', brevo, now)).toEqual({
      ok: true,
    });
  });
});
