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
import { ObservabilityModule } from './observability/platform/observability.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ClientIpThrottlerGuard } from './common/security/client-ip-throttler.guard';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { LoggerModule } from 'nestjs-pino';
import { BullModule } from '@nestjs/bullmq';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { bullConnectionFromRedisUrl } from './config/bull-connection.util';
import type { AppConfig, RedisConfig } from './config/configuration';
import { buildPinoOptions } from './common/logging/pino-options.factory';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { SubscriptionAccessInterceptor } from './plans/interceptors/subscription-access.interceptor';
import { RequestContextMiddleware } from './common/middleware/request-context.middleware';
import { DatabaseModule } from './database/prisma.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { SecurityReportsModule } from './security-reports/security-reports.module';
import { SessionCookieInterceptor } from './identity/session-cookie/session-cookie.interceptor';
import { MetricsModule } from './observability/metrics/metrics.module';
import { RumModule } from './observability/rum/rum.module';
import { IdentityModule } from './identity/identity.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AcademyModule } from './academy/academy.module';
import { PlansModule } from './plans/plans.module';
import { LiveSessionsModule } from './live-sessions/live-sessions.module';
import { CourseModule } from './course/course.module';
import { LearningModule } from './learning/learning.module';
import { CertificatesModule } from './certificates/certificates.module';
import { InstructorModule } from './instructor/instructor.module';
import { CommunityModule } from './community/community.module';
import { MediaModule } from './media/media.module';
import { RetentionModule } from './retention/retention.module';
import { WebsiteModule } from './website/website.module';
import { DomainModule } from './domain/domain.module';
import { PublicWebsiteModule } from './public-website/public-website.module';
import { BillingModule } from './billing/billing.module';
import { CourseCommerceModule } from './course-commerce/course-commerce.module';
import { ProvisioningModule } from './provisioning/provisioning.module';
import { AuditLogModule } from './audit-log/audit-log.module';
import { PlatformModule } from './platform/platform.module';
import { PlatformContactModule } from './platform-contact/platform-contact.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { NotificationEventsModule } from './notification-events/notification-events.module';
import { CommunicationsModule } from './communications/communications.module';
import { CommunicationCampaignsModule } from './communications/campaigns/communication-campaigns.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SearchModule } from './search/search.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { SecurityEventsModule } from './security-events/security-events.module';
import { SecurityMonitoringModule } from './security-events/security-monitoring.module';

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
    // independent counter).
    //
    // Confirmed against real production logs — was originally wired as
    // `new ThrottlerStorageRedisService(redisService.getClient())`,
    // reusing `RedisService`'s shared connection. That looked right but
    // isn't: `RedisModule`'s `onModuleInit` (where `RedisService` actually
    // creates its client) runs during Nest's lifecycle-hook phase, which
    // is *after* this factory already ran as part of provider
    // instantiation — so `getClient()` returned `undefined` here, every
    // time. `ThrottlerStorageRedisService`'s constructor then silently
    // treated that `undefined` as "connection options" and created its
    // own brand-new ioredis client with no config at all, defaulting to
    // 127.0.0.1:6379 — invisible in dev/CI purely because Redis also
    // happens to be on localhost there. Fixed by building this storage's
    // connection directly from config instead of depending on another
    // provider's post-init state.
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redis = configService.getOrThrow<RedisConfig>('redis');
        const redisUrl = new URL(redis.url);
        return {
          throttlers: [{ ttl: 60_000, limit: 120 }],
          storage: new ThrottlerStorageRedisService({
            host: redisUrl.hostname,
            port: Number(redisUrl.port || 6379),
            password: redisUrl.password || undefined,
          }),
        };
      },
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redis = configService.getOrThrow<RedisConfig>('redis');
        const app = configService.getOrThrow<AppConfig>('app');
        // Phase 7 — was `{ url: redis.url, maxRetriesPerRequest: null }`.
        // ioredis's `RedisOptions` has no `url` field; an unrecognized key
        // is silently ignored, so this connected to ioredis's *default*
        // 127.0.0.1:6379 rather than wherever `REDIS_URL` actually points.
        // The URL is parsed into real fields (host, port, credentials, DB
        // index, TLS) — see `bullConnectionFromRedisUrl`.
        return {
          // BullMQ requires its own connection with `maxRetriesPerRequest:
          // null` — deliberately separate from `RedisService`'s
          // connectivity-check client, not a shared instance.
          connection: bullConnectionFromRedisUrl(redis.url),
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
    // W3 — `@Global()` `security_events` writer (OTP & Security Monitoring),
    // registered beside the other global leaves for the same reason.
    SecurityEventsModule,
    CommunicationsModule,
    // W3-compose — Platform Owner "Compose and send" and academy "Messages".
    CommunicationCampaignsModule,
    HealthModule,
    SecurityReportsModule,
    // P64 Phase 2 §U — the first metrics registry in the codebase.
    MetricsModule,
    RumModule,
    ObservabilityModule,
    // New Customer Onboarding — docs/NEW_CUSTOMER_ONBOARDING.md.
    OnboardingModule,
    TenancyModule,
    IdentityModule,
    AcademyModule,
    PlansModule,
    // Phase 12 — Live Sessions add-on (Zoom).
    LiveSessionsModule,
    CourseModule,
    LearningModule,
    CertificatesModule,
    InstructorModule,
    CommunityModule,
    MediaModule,
    // P64 Communications C6 — hosted-video retention (plan §31/§32).
    // A leaf module: it imports `PlansModule` and `MediaModule` and
    // nothing imports it.
    RetentionModule,
    WebsiteModule,
    DomainModule,
    PublicWebsiteModule,
    BillingModule,
    CourseCommerceModule,
    ProvisioningModule,
    PlatformModule,
    // TASK 7 — Atlas marketing contact form + Platform Owner inbox.
    PlatformContactModule,
    AnalyticsModule,
    NotificationsModule,
    SearchModule,
    // Phase 8 — Support, Audit & Dashboards.
    DashboardModule,
    // W3 — Platform Owner OTP & Security Monitoring + security retention sweep.
    SecurityMonitoringModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
    /*
      Runs after every guard, so the tenant context it reads has already
      been verified. An expired tenant keeps full READ access and every
      billing/support/recovery route; what it loses is the ability to
      mutate its own tenant data. See the interceptor's own doc comment for
      why this is not a guard and why it engages only where a tenant scope
      exists.
    */
    { provide: APP_INTERCEPTOR, useClass: SubscriptionAccessInterceptor },
    // Production-readiness pass — refresh tokens leave the server only in the
    // HttpOnly session cookie, never in a response body (see the interceptor).
    { provide: APP_INTERCEPTOR, useClass: SessionCookieInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
