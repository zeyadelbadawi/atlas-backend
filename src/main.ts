/**
 * Application entry point.
 *
 * Establishes, in order: structured logging (replacing Nest's default
 * console logger), security headers, CORS (validated allowlist, never a
 * wildcard in production), global request validation, the `/api/v1`
 * versioning prefix every future business endpoint will live under
 * (`/health` stays unprefixed/unversioned — an infrastructure endpoint, not
 * a business one), and OpenAPI documentation (master plan §10 "Docs").
 */
import 'reflect-metadata';
// Phase 10 — must run before any instrumented module is imported, which
// is why it sits above every other import but `reflect-metadata`. No-ops
// entirely when `SENTRY_DSN` is unset; see `observability/sentry.ts`.
import { initializeSentry } from './observability/sentry';

const sentryEnabled = initializeSentry();

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { throwClassValidatorViolations } from './common/validation/class-validator-violations.util';
import type { AppConfig } from './config/configuration';
import type { MediaStorageConfig } from './config/configuration';
import type { PlatformDomainRuntimeConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  const logger = app.get(Logger);
  app.useLogger(logger);
  app.useGlobalInterceptors(new LoggerErrorInterceptor());

  const configService = app.get(ConfigService);
  const config = configService.getOrThrow<AppConfig>('app');

  // Phase P8 — the default Express JSON body limit (100kb) rejects any
  // real base64-encoded image/document before it ever reaches
  // `MediaController` (base64 inflates binary size by ~4/3). Sized with
  // generous headroom above `MEDIA_MAX_UPLOAD_BYTES` — deliberately NOT
  // the tight ~1.33x base64-inflation factor alone: a payload just
  // moderately over the real ceiling must still reach
  // `MediaService`'s own real byte-length check (the actual enforced
  // limit, master plan §13: "server-side explicitly, per asset type")
  // and get a proper 413, rather than tripping this outer, cruder limit
  // first and surfacing as an opaque 500 (confirmed as a real failure
  // mode during implementation with an 11MB-over-a-10MB-ceiling test
  // payload landing within a few percent of a tightly-margined limit).
  const mediaConfig = configService.getOrThrow<MediaStorageConfig>('media');
  const bodyLimitBytes = mediaConfig.maxUploadBytes * 3;
  app.useBodyParser('json', { limit: bodyLimitBytes });

  /**
   * Phase 10 — trust the reverse proxy in front of us, but only it.
   *
   * Without this, Express reports the immediate socket peer as
   * `request.ip`, which in production is Caddy on the compose network.
   * Every per-IP rate limiter (`signin-rate-limit.guard.ts`,
   * `register-rate-limit.guard.ts`, `password-reset-rate-limit.guard.ts`
   * and the global `ThrottlerGuard`) keys on `request.ip`, so all of them
   * were bucketing every visitor on the planet into a single shared
   * counter — the exact "accidental global lockout" shape this phase's
   * own hardening review calls out, since one abusive client could
   * exhaust the budget for everyone.
   *
   * The value is a trust LIST, never `true`. `true` would trust the
   * leftmost `X-Forwarded-For` entry from any caller, letting a client
   * forge its own address and evade or poison rate limiting.
   * Loopback/link-local/unique-local covers exactly the private ranges a
   * sidecar proxy occupies (Docker's bridge network included) and nothing
   * routable from outside.
   */
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');

  app.use(helmet());

  // Phase 7 — production serves the platform's main domain, every academy's
  // `{slug}.{baseDomain}` subdomain, and (eventually) connected custom
  // domains, all from this one API. A fixed array can't express "any
  // subdomain of X" — origins are created dynamically at academy-provision
  // time, long after boot, so they can never be enumerated up front. This
  // keeps the static `CORS_ALLOWED_ORIGINS` allowlist (dev origins, any
  // explicitly-configured extra origin) as the base case, and additionally
  // allows the platform's own base domain and any single-label subdomain of
  // it, once `PLATFORM_BASE_DOMAIN` is configured. No wildcard is ever
  // reflected — the actual matched origin is echoed back, same as before.
  const platformDomainConfig =
    configService.get<PlatformDomainRuntimeConfig>('platformDomain');
  const staticAllowedOrigins = new Set(config.corsAllowedOrigins as string[]);
  const baseDomain = platformDomainConfig?.baseDomain;
  const subdomainPattern = baseDomain
    ? new RegExp(`^https:\\/\\/([a-z0-9-]+)\\.${baseDomain.replace(/\./g, '\\.')}$`, 'i')
    : undefined;

  app.enableCors({
    origin: (origin, callback) => {
      // No Origin header (same-origin request, curl, server-to-server) —
      // nothing for CORS to police.
      if (!origin) return callback(null, true);
      if (staticAllowedOrigins.has(origin)) return callback(null, true);
      if (baseDomain && origin === `https://${baseDomain}`) return callback(null, true);
      if (subdomainPattern?.test(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Real per-field violations instead of Nest's default flat English
      // message array (which `AllExceptionsFilter` could only ever report
      // as `field: 'unknown'`) — see `class-validator-violations.util.ts`.
      exceptionFactory: (errors) => throwClassValidatorViolations(errors),
    }),
  );

  // `/health` is deliberately excluded — infrastructure endpoints are
  // conventionally unprefixed/unversioned, distinct from the business API
  // every later phase adds under `/api/v1`.
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // API documentation stays out of production by default — nothing in P0
  // exposes anything sensitive today, but the default should be safe
  // before a later phase adds one endpoint that shouldn't be publicly
  // discoverable in its full shape.
  if (!config.isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Atlas API')
        .setDescription(
          'Atlas backend API. See Reports/ATLAS_BACKEND_MASTER_PLAN.md (atlas frontend repo) for the full architecture.',
        )
        .setVersion('0.0.0-p0')
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(config.port);
  logger.log(`Atlas backend listening on port ${config.port} (${config.nodeEnv})`);
  // Stated explicitly at boot so an operator can tell at a glance whether
  // error reporting is actually on, rather than assuming it is because
  // the code exists.
  logger.log(
    sentryEnabled
      ? 'Sentry error reporting: ENABLED'
      : 'Sentry error reporting: DISABLED (no SENTRY_DSN configured)',
  );
}

bootstrap().catch((error: unknown) => {
  // The logger DI container may not be up yet if bootstrap itself failed
  // (e.g. invalid env) — fall back to console so the failure is never
  // silently swallowed.
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
