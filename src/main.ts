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
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, LoggerErrorInterceptor } from 'nestjs-pino';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import helmet from 'helmet';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import type { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  const logger = app.get(Logger);
  app.useLogger(logger);
  app.useGlobalInterceptors(new LoggerErrorInterceptor());

  const configService = app.get(ConfigService);
  const config = configService.getOrThrow<AppConfig>('app');

  app.use(helmet());

  app.enableCors({
    origin: config.corsAllowedOrigins as string[],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
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
}

bootstrap().catch((error: unknown) => {
  // The logger DI container may not be up yet if bootstrap itself failed
  // (e.g. invalid env) — fall back to console so the failure is never
  // silently swallowed.
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
