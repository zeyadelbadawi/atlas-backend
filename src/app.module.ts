/**
 * Root application module.
 *
 * Wires the cross-cutting infrastructure every later phase builds on:
 * validated configuration, structured logging, database/Redis
 * connectivity, global error shaping, a health endpoint, and a rate-limit
 * foundation (Phase P0) — plus, from Phase P1 onward, each domain module
 * imported here as its own module, never inlined into this file.
 *
 * `BullModule.forRootAsync` lives here rather than inside `IdentityModule`
 * because the queue *connection* (ADR-006: BullMQ on the same Redis
 * instance as cache/sessions/rate-limit, ADR-004) is platform
 * infrastructure every later phase's workers will also need — matching how
 * `DatabaseModule`/`RedisModule` are already registered at this level, not
 * per-domain-module.
 */
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { BullModule } from '@nestjs/bullmq';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import type { AppConfig, RedisConfig } from './config/configuration';
import { buildPinoOptions } from './common/logging/pino-options.factory';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { DatabaseModule } from './database/prisma.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './identity/identity.module';
import { TenancyModule } from './tenancy/tenancy.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
      envFilePath: ['.env'],
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildPinoOptions(configService.getOrThrow<AppConfig>('app')),
    }),
    // A generous, global default rate limit — infrastructure-level
    // protection, not the tuned per-endpoint limits (auth, payments)
    // master plan §16/§18 call for. Those apply their own, stricter
    // `@Throttle()` overrides once those endpoints exist (P1, P12+); this
    // is only the foundation so no route is ever unlimited by omission.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redis = configService.getOrThrow<RedisConfig>('redis');
        return {
          // BullMQ requires its own connection with `maxRetriesPerRequest:
          // null` — deliberately separate from `RedisService`'s
          // connectivity-check client, not a shared instance.
          connection: { url: redis.url, maxRetriesPerRequest: null },
        };
      },
    }),
    DatabaseModule,
    RedisModule,
    HealthModule,
    TenancyModule,
    IdentityModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
