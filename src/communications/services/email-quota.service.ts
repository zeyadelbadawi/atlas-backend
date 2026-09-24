/**
 * EmailQuotaService — per-provider send budgets in Redis.
 *
 * Free-tier providers are hard-capped (Brevo 300/day, Resend 100/day) and
 * a security email (password reset, OTP) must never be the one that finds
 * the cap. So each category class reserves against a LINE of the daily
 * and monthly budget:
 *
 *   security + transactional   100 %   (may use the whole budget)
 *   lifecycle                   85 %
 *   engagement + operational    70 %
 *
 * Counters (`comm:quota:{provider}:d:{yyyymmdd}` / `:m:{yyyymm}`, UTC) are
 * incremented on an ACCEPTED send only (`recordAccepted`), never on a
 * reservation — a rejected or failed request does not burn quota at the
 * provider either. The per-second limiter is a fixed one-second window
 * (`comm:rate:{provider}:{epochSecond}`), a plain approximation of a
 * token bucket that needs no Lua. A provider whose capability is
 * undefined is unlimited on that axis (the stub).
 *
 * Redis being unreachable fails OPEN for the reservation (the send goes
 * out; the provider enforces its own cap) and is logged — a quota
 * bookkeeping failure must never take security email down with it.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import type {
  EmailCategory,
  EmailProviderCapabilities,
} from '../../identity/services/email-provider.interface';
import { CommunicationMetricsService } from './communication-metrics.service';

export type QuotaWindow = 'daily' | 'monthly';

export interface QuotaWindowUsage {
  readonly used: number;
  /** Undefined = unlimited. */
  readonly limit?: number;
  /** `used / limit`, 0 when unlimited. */
  readonly ratio: number;
}

export interface QuotaUsage {
  readonly provider: string;
  readonly daily: QuotaWindowUsage;
  readonly monthly: QuotaWindowUsage;
}

export type QuotaDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'daily' | 'monthly' | 'rate' };

const CATEGORY_LINE: Readonly<Record<EmailCategory, number>> = {
  security: 1,
  transactional: 1,
  lifecycle: 0.85,
  engagement: 0.7,
  operational: 0.7,
};

const DAY_TTL_SECONDS = 3 * 24 * 60 * 60;
const MONTH_TTL_SECONDS = 62 * 24 * 60 * 60;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function dailyKey(provider: string, now: Date): string {
  return `comm:quota:${provider}:d:${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
}

export function monthlyKey(provider: string, now: Date): string {
  return `comm:quota:${provider}:m:${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}`;
}

export function categoryLine(category: EmailCategory): number {
  return CATEGORY_LINE[category] ?? 1;
}

@Injectable()
export class EmailQuotaService {
  private readonly logger = new Logger(EmailQuotaService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly metrics: CommunicationMetricsService,
  ) {}

  /**
   * May this category send through this provider right now? Checks the
   * class line against both windows, then the per-second window (which is
   * consumed on the spot — a reservation that is not used within the
   * second simply expires with it).
   */
  async reserve(
    provider: string,
    category: EmailCategory,
    capabilities: EmailProviderCapabilities,
    now = new Date(),
  ): Promise<QuotaDecision> {
    try {
      const usage = await this.usage(provider, capabilities, now);
      const line = categoryLine(category);
      if (
        usage.daily.limit !== undefined &&
        usage.daily.used >= Math.floor(usage.daily.limit * line)
      ) {
        return { ok: false, reason: 'daily' };
      }
      if (
        usage.monthly.limit !== undefined &&
        usage.monthly.used >= Math.floor(usage.monthly.limit * line)
      ) {
        return { ok: false, reason: 'monthly' };
      }
      if (capabilities.perSecond !== undefined) {
        const client = this.redisService.getClient();
        const key = `comm:rate:${provider}:${Math.floor(now.getTime() / 1000)}`;
        const count = await client.incr(key);
        if (count === 1) await client.expire(key, 2);
        if (count > capabilities.perSecond) return { ok: false, reason: 'rate' };
      }
      return { ok: true };
    } catch (error) {
      this.logger.warn(
        { provider, error: error instanceof Error ? error.message : String(error) },
        'Email quota reservation could not be checked — failing open.',
      );
      return { ok: true };
    }
  }

  /** Called once the provider returned 2xx. Bumps both windows and the used-ratio gauges. */
  async recordAccepted(
    provider: string,
    capabilities: EmailProviderCapabilities,
    now = new Date(),
  ): Promise<void> {
    try {
      const client = this.redisService.getClient();
      const dKey = dailyKey(provider, now);
      const mKey = monthlyKey(provider, now);
      const [daily, monthly] = await Promise.all([client.incr(dKey), client.incr(mKey)]);
      if (daily === 1) await client.expire(dKey, DAY_TTL_SECONDS);
      if (monthly === 1) await client.expire(mKey, MONTH_TTL_SECONDS);
      this.publishGauges(provider, capabilities, daily, monthly);
    } catch (error) {
      this.logger.warn(
        { provider, error: error instanceof Error ? error.message : String(error) },
        'Email quota counter could not be incremented.',
      );
    }
  }

  async usage(
    provider: string,
    capabilities: EmailProviderCapabilities,
    now = new Date(),
  ): Promise<QuotaUsage> {
    const client = this.redisService.getClient();
    const [dailyRaw, monthlyRaw] = await client.mget(
      dailyKey(provider, now),
      monthlyKey(provider, now),
    );
    const daily = Number(dailyRaw ?? 0);
    const monthly = Number(monthlyRaw ?? 0);
    this.publishGauges(provider, capabilities, daily, monthly);
    return {
      provider,
      daily: {
        used: daily,
        limit: capabilities.dailyLimit,
        ratio: capabilities.dailyLimit ? daily / capabilities.dailyLimit : 0,
      },
      monthly: {
        used: monthly,
        limit: capabilities.monthlyLimit,
        ratio: capabilities.monthlyLimit ? monthly / capabilities.monthlyLimit : 0,
      },
    };
  }

  private publishGauges(
    provider: string,
    capabilities: EmailProviderCapabilities,
    daily: number,
    monthly: number,
  ): void {
    if (capabilities.dailyLimit) {
      this.metrics.setQuotaUsedRatio(provider, 'daily', daily / capabilities.dailyLimit);
    }
    if (capabilities.monthlyLimit) {
      this.metrics.setQuotaUsedRatio(
        provider,
        'monthly',
        monthly / capabilities.monthlyLimit,
      );
    }
  }
}
