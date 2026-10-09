/**
 * Per-Platform-Owner rate limit on watermark lookups.
 *
 * A lookup discloses a person's name, email and phone. The guard stack
 * already restricts it to Platform Owners; this bounds what a stolen
 * operator session could harvest before anyone notices (every lookup is
 * also audited). Defaults: 30 per 10 minutes (`WATERMARK_LOOKUP_RATE_LIMIT_*`).
 *
 * FAILS CLOSED, unlike the learner grant limiter: lookups are rare and
 * operator-initiated, so a Redis outage costs a retry, while failing open
 * would remove the bound exactly when monitoring is degraded.
 */
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import type { ForensicWatermarkConfig } from '../../config/configuration';

@Injectable()
export class WatermarkLookupRateLimiter {
  private readonly logger = new Logger(WatermarkLookupRateLimiter.name);
  private readonly max: number;
  private readonly windowSeconds: number;

  constructor(
    private readonly redisService: RedisService,
    configService: ConfigService,
  ) {
    const config = configService.getOrThrow<ForensicWatermarkConfig>('forensicWatermark');
    this.max = config.lookupRateLimit.max;
    this.windowSeconds = config.lookupRateLimit.windowSeconds;
  }

  async consume(platformOwnerId: string): Promise<void> {
    let count: number;
    try {
      const client = this.redisService.getClient();
      const key = `watermark_lookups:${platformOwnerId}`;
      count = await client.incr(key);
      if (count === 1) await client.expire(key, this.windowSeconds);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Watermark lookup rate limiter unavailable; refusing the lookup.',
      );
      throw new ServiceUnavailableException({
        messageKey: 'errors.watermark.lookupUnavailable',
      });
    }
    if (count > this.max) {
      throw new HttpException(
        {
          messageKey: 'errors.watermark.lookupRateLimited',
          details: { windowSeconds: this.windowSeconds },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
