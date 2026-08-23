/**
 * Root application module — Phase P0 (Foundation).
 *
 * Wires the cross-cutting infrastructure every later phase builds on:
 * validated configuration, structured logging, database/Redis
 * connectivity, global error shaping, a health endpoint, and a rate-limit
 * foundation. Deliberately contains no domain modules — those begin
 * arriving in Phase P1 (`IdentityModule`) onward, each imported here as its
 * own module, never inlined into this file.
 */
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import type { AppConfig } from './config/configuration';
import { buildPinoOptions } from './common/logging/pino-options.factory';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { DatabaseModule } from './database/prisma.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';

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
    DatabaseModule,
    RedisModule,
    HealthModule,
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
