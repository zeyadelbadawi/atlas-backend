/**
 * PublicWebsiteCacheService — the real, testable "edge-cache" layer
 * behind the public runtime (master plan §21 P11: "SSR/edge-cache layer
 * recommended by the Backend Blueprint"). See `Reports/ARCHITECTURE.md`,
 * P11, "Why This Is Not SSR" for the full discrepancy this deliberately
 * resolves: the real frontend is a 100% client-rendered SPA (confirmed by
 * direct inspection — `PublicWebsiteRouter` mounts React components that
 * fetch JSON, there is no server-rendered HTML anywhere in the contract),
 * so there is no HTML output for a backend "SSR" layer to produce. What
 * this repo's own existing infrastructure genuinely supports — and what
 * is actually useful here — is response caching in front of the
 * expensive parts of the public JSON read path (the full `sections` JSONB
 * payload in particular), backed by the SAME Redis connection
 * (`RedisService`) every other phase already shares. No new cache system
 * was introduced.
 *
 * Cache-isolation strategy (master plan §17 "Cache Isolation"): every key
 * embeds the Academy id AND the resolved `WebsiteConfiguration.
 * configVersion` at read time. `configVersion` is incremented on every
 * real publish (`WebsiteConfigurationService.publishConfiguration`, P9,
 * unmodified) — a stale cache entry (keyed by the OLD version) is simply
 * never looked up again once a new publish happens; a fresh key is
 * computed and misses, populating a new entry. This makes the cache
 * self-invalidating by construction, with zero explicit invalidation call
 * needed on publish and zero risk of ever serving stale-but-still-"valid"
 * content past a republish. Because the version number itself is only
 * ever read from a `status: 'published'` — gated query
 * (`WebsiteConfigurationRepository.findPublishedByAcademyId`), a draft
 * configuration's version is never the key of anything cached here — a
 * draft can structurally never populate or be read from this cache.
 *
 * Hostname-resolution entries are cached separately, keyed by the exact
 * normalized input hostname string — two different hostnames can never
 * collide (they are, by definition, different keys), so this cannot leak
 * one Academy's identity to a visitor of another Academy's hostname.
 */
import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

const HOSTNAME_TTL_SECONDS = 60;
const CONTENT_TTL_SECONDS = 300;

function hostnameKey(hostname: string): string {
  return `public:hostname:v1:${hostname}`;
}

function configKey(academyId: string, configVersion: number): string {
  return `public:config:v1:${academyId}:${configVersion}`;
}

function pagesKey(academyId: string, configVersion: number): string {
  return `public:pages:v1:${academyId}:${configVersion}`;
}

@Injectable()
export class PublicWebsiteCacheService {
  constructor(private readonly redisService: RedisService) {}

  async getHostnameResolution<T>(hostname: string): Promise<T | undefined> {
    return this.getJson<T>(hostnameKey(hostname));
  }

  async setHostnameResolution<T>(hostname: string, value: T): Promise<void> {
    await this.setJson(hostnameKey(hostname), value, HOSTNAME_TTL_SECONDS);
  }

  async getConfiguration<T>(
    academyId: string,
    configVersion: number,
  ): Promise<T | undefined> {
    return this.getJson<T>(configKey(academyId, configVersion));
  }

  async setConfiguration<T>(
    academyId: string,
    configVersion: number,
    value: T,
  ): Promise<void> {
    await this.setJson(configKey(academyId, configVersion), value, CONTENT_TTL_SECONDS);
  }

  async getPages<T>(academyId: string, configVersion: number): Promise<T | undefined> {
    return this.getJson<T>(pagesKey(academyId, configVersion));
  }

  async setPages<T>(academyId: string, configVersion: number, value: T): Promise<void> {
    await this.setJson(pagesKey(academyId, configVersion), value, CONTENT_TTL_SECONDS);
  }

  private async getJson<T>(key: string): Promise<T | undefined> {
    const raw = await this.redisService.getClient().get(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // A corrupted/foreign entry is treated as a cache miss, never a
      // thrown error on the public read path.
      return undefined;
    }
  }

  private async setJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redisService.getClient().set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }
}
