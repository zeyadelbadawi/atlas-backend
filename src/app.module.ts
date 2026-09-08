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
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
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
import { RedisService } from './redis/redis.service';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './identity/identity.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AcademyModule } from './academy/academy.module';
import { PlansModule } from './plans/plans.module';
import { CourseModule } from './course/course.module';
import { LearningModule } from './learning/learning.module';
import { InstructorModule } from './instructor/instructor.module';
import { CommunityModule } from './community/community.module';
import { MediaModule } from './media/media.module';
import { WebsiteModule } from './website/website.module';
import { DomainModule } from './domain/domain.module';
import { PublicWebsiteModule } from './public-website/public-website.module';
import { BillingModule } from './billing/billing.module';
import { CourseCommerceModule } from './course-commerce/course-commerce.module';
import { ProvisioningModule } from './provisioning/provisioning.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { PlatformModule } from './platform/platform.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { NotificationEventsModule } from './notification-events/notification-events.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SearchModule } from './search/search.module';

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
    // Phase 7 — was `forRoot` with NestJS's default in-memory storage,
    // correct for exactly one instance and silently wrong the moment a
    // second instance/process joins (each would enforce its own
    // independent counter). Backed by the same shared Redis connection
    // (`RedisService`) every other cross-cutting concern here already
    // uses, not a second connection.
    ThrottlerModule.forRootAsync({
      inject: [RedisService],
      useFactory: (redisService: RedisService) => ({
        throttlers: [{ ttl: 60_000, limit: 120 }],
        storage: new ThrottlerStorageRedisService(redisService.getClient()),
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redis = configService.getOrThrow<RedisConfig>('redis');
        const app = configService.getOrThrow<AppConfig>('app');
        // Phase 7 — was `{ url: redis.url, maxRetriesPerRequest: null }`.
        // ioredis's `RedisOptions` has no `url` field; an unrecognized key
        // is silently ignored, so this connected to ioredis's *default*
        // 127.0.0.1:6379 rather than wherever `REDIS_URL` actually points
        // — invisible in every environment this app had run in so far
        // (local dev, CI, e2e), because Redis has always incidentally
        // been on localhost there too. Real production is the first
        // environment where it isn't (a compose service named `redis`,
        // with a password) — confirmed via a genuine, continuous
        // ECONNREFUSED-to-127.0.0.1 error stream once actually deployed.
        // Parsed into real `host`/`port`/`password` fields instead, which
        // `RedisOptions` does define.
        const redisUrl = new URL(redis.url);
        return {
          // BullMQ requires its own connection with `maxRetriesPerRequest:
          // null` — deliberately separate from `RedisService`'s
          // connectivity-check client, not a shared instance.
          connection: {
            host: redisUrl.hostname,
            port: Number(redisUrl.port || 6379),
            password: redisUrl.password || undefined,
            maxRetriesPerRequest: null,
          },
          // Test runs get their own Redis key namespace (`bull:` vs.
          // `bull-test:`), never the default shared with a real dev/prod
          // instance. Discovered during the Organization Management
          // Completion fix pass: a locally running `npm run dev` server
          // and the e2e test suite both point at the same local Redis by
          // default — without this, their BullMQ workers race to consume
          // the same job, and whichever process's worker "wins" determines
          // whether the *other* process's in-memory `StubEmailProvider`
          // ever sees the result. That looked like flaky test timing; it
          // was actually two unrelated processes fighting over one queue.
          prefix: app.isTest ? 'bull-test' : 'bull',
        };
      },
    }),
    DatabaseModule,
    RedisModule,
    // `@Global()` — every later module can inject `AuditLogWriterService`
    // without importing this explicitly; registered early purely so its
    // own providers exist before anything might need them.
    AuditLogModule,
    // `@Global()` — same reasoning as `AuditLogModule` immediately above,
    // for `NotificationFanoutService`/`NotificationsRepository` (P17).
    NotificationEventsModule,
    HealthModule,
    TenancyModule,
    IdentityModule,
    AcademyModule,
    PlansModule,
    CourseModule,
    LearningModule,
    InstructorModule,
    CommunityModule,
    MediaModule,
    WebsiteModule,
    DomainModule,
    PublicWebsiteModule,
    BillingModule,
    CourseCommerceModule,
    ProvisioningModule,
    PlatformModule,
    AnalyticsModule,
    NotificationsModule,
    SearchModule,
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
