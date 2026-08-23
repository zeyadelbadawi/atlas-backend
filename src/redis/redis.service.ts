/**
 * RedisService — the one Redis connection the app shares.
 *
 * P0 wires connectivity only (proven by the health check). No cache,
 * rate-limit, or BullMQ usage is implemented yet — those are the domains
 * that consume this connection starting P1 (refresh-token store) and P12+
 * (queues, ADR-006).
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { RedisConfig } from '../config/configuration';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client!: Redis;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const redis = this.configService.get<RedisConfig>('redis');
    this.client = new Redis(redis?.url ?? '', {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });

    this.client.on('error', (error: Error) => {
      this.logger.error(`Redis connection error: ${error.message}`);
    });

    this.client.on('connect', () => {
      this.logger.log('Redis connection established.');
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit();
  }

  getClient(): Redis {
    return this.client;
  }

  /** Used by the health check — a real round-trip, not just "is the client object constructed." */
  async isHealthy(): Promise<boolean> {
    const response = await this.client.ping();
    return response === 'PONG';
  }
}
