import { Injectable } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { RedisService } from '../../redis/redis.service';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async check(key: string): Promise<HealthIndicatorResult> {
    try {
      const healthy = await this.redis.isHealthy();
      if (!healthy) {
        throw new Error('PING did not return PONG');
      }
      return this.getStatus(key, true);
    } catch (error) {
      const result = this.getStatus(key, false, { message: this.describe(error) });
      throw new HealthCheckError('Redis check failed', result);
    }
  }

  private describe(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown Redis error';
  }
}
