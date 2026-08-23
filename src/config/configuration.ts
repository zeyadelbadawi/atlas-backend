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
  /** Superuser connection — Prisma CLI (migrations) only. Never used for application queries; see `appUrl`. */
  readonly url: string;
  /** Non-superuser, non-BYPASSRLS connection — what `PrismaService` actually connects with at runtime, so RLS applies to every application query (Phase P2). */
  readonly appUrl: string;
}

export interface RedisConfig {
  readonly url: string;
}

/** Phase P1 — Identity, Auth & Sessions configuration (master plan §8). */
export interface IdentityConfig {
  readonly jwtAccessSecret: string;
  readonly jwtAccessTtlSeconds: number;
  readonly refreshTokenTtlDays: number;
  readonly passwordResetTokenTtlMinutes: number;
  readonly signInRateLimit: { readonly max: number; readonly windowSeconds: number };
  readonly passwordResetRateLimit: {
    readonly max: number;
    readonly windowSeconds: number;
  };
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
    appUrl: env.APP_DATABASE_URL,
  };

  const redis: RedisConfig = {
    url: env.REDIS_URL,
  };

  const identity: IdentityConfig = {
    jwtAccessSecret: env.JWT_ACCESS_SECRET,
    jwtAccessTtlSeconds: Number(env.JWT_ACCESS_TTL_SECONDS ?? 900),
    refreshTokenTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 30),
    passwordResetTokenTtlMinutes: Number(env.PASSWORD_RESET_TOKEN_TTL_MINUTES ?? 45),
    signInRateLimit: {
      max: Number(env.AUTH_SIGNIN_RATE_LIMIT_MAX ?? 10),
      windowSeconds: Number(env.AUTH_SIGNIN_RATE_LIMIT_WINDOW_SECONDS ?? 900),
    },
    passwordResetRateLimit: {
      max: Number(env.AUTH_PASSWORD_RESET_RATE_LIMIT_MAX ?? 5),
      windowSeconds: Number(env.AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS ?? 3600),
    },
  };

  return { app, database, redis, identity };
};
