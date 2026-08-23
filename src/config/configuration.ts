/**
 * Typed application configuration.
 *
 * `ConfigService.get<AppConfig>('app')` is the one place the rest of the
 * app reads configuration from — no module reaches into `process.env`
 * directly (the same rule the frontend's `ENV` object enforces on the
 * client side). Values here are already validated by `validateEnv`
 * (env.validation.ts) by the time this factory runs.
 */
import type { EnvVariables } from './env.validation';

export interface AppConfig {
  readonly nodeEnv: EnvVariables['NODE_ENV'];
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  readonly port: number;
  readonly logLevel: EnvVariables['LOG_LEVEL'];
  readonly corsAllowedOrigins: readonly string[];
}

export interface DatabaseConfig {
  readonly url: string;
}

export interface RedisConfig {
  readonly url: string;
}

/**
 * Parses the comma-separated `CORS_ALLOWED_ORIGINS` env var into a list.
 * In development/test with nothing configured, falls back to the Vite dev
 * server's default origin only — never a wildcard, and never used at all
 * in production, where `validateEnv` already guarantees the variable is set.
 */
function parseCorsOrigins(
  raw: string | undefined,
  isProduction: boolean,
): readonly string[] {
  const parsed =
    raw
      ?.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [];
  if (parsed.length > 0) return parsed;
  if (isProduction) return []; // unreachable in practice — validateEnv already throws first.
  return ['http://localhost:5173'];
}

export default () => {
  const env = process.env as unknown as EnvVariables;
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';

  const app: AppConfig = {
    nodeEnv,
    isProduction,
    isDevelopment: nodeEnv === 'development',
    isTest: nodeEnv === 'test',
    port: Number(env.PORT ?? 3000),
    logLevel: env.LOG_LEVEL ?? 'info',
    corsAllowedOrigins: parseCorsOrigins(env.CORS_ALLOWED_ORIGINS, isProduction),
  };

  const database: DatabaseConfig = {
    url: env.DATABASE_URL,
  };

  const redis: RedisConfig = {
    url: env.REDIS_URL,
  };

  return { app, database, redis };
};
