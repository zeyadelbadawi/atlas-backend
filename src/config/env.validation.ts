/**
 * Environment validation.
 *
 * The app refuses to boot with a missing or malformed required environment
 * variable — there is no silent fallback for anything connectivity- or
 * security-critical (DATABASE_URL, REDIS_URL). This mirrors the frontend's
 * own `src/config/env.config.ts` discipline (one centralized, validated
 * config layer; features never read `process.env` directly) and the master
 * plan's explicit P0 requirement: "environment validation."
 */
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'staging', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z
    .string()
    .min(
      1,
      'DATABASE_URL is required — the backend cannot start without a database connection string.',
    )
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      {
        message: 'DATABASE_URL must be a postgresql:// connection string.',
      },
    ),

  REDIS_URL: z
    .string()
    .min(
      1,
      'REDIS_URL is required — the backend cannot start without a Redis connection string.',
    )
    .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
      message: 'REDIS_URL must be a redis:// or rediss:// connection string.',
    }),

  // --- Phase P2 — Organizations, Membership & Multi-Tenancy Core ---
  // The application's RUNTIME database connection, distinct from
  // DATABASE_URL (which the Prisma CLI uses for migrations/DDL and stays
  // pointed at the superuser role). This must be a role with no superuser
  // or BYPASSRLS attribute — Postgres row security is never applied to a
  // superuser connection, under any circumstance, including tables with
  // FORCE ROW LEVEL SECURITY (empirically verified during P2; see
  // `prisma/migrations/20260823183500_p2_app_role_rls_enforcement`). A
  // backend that connected to Postgres with only DATABASE_URL would make
  // every RLS policy in this codebase silently inert.
  APP_DATABASE_URL: z
    .string()
    .min(
      1,
      'APP_DATABASE_URL is required — the backend cannot start without a non-superuser ' +
        'runtime database connection (RLS is inert against a superuser connection).',
    )
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      { message: 'APP_DATABASE_URL must be a postgresql:// connection string.' },
    ),

  // Comma-separated allowed origins. Required (non-empty, no wildcard) in
  // production; optional in development/test, where a permissive localhost
  // default is used instead — see `parseCorsOrigins` in configuration.ts.
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // --- Phase P1 — Identity, Auth & Sessions (master plan §8, §21 P1) ---
  // Access-token signing secret. Required, no default — a JWT secret is
  // exactly the kind of connectivity/security-critical value P0's env
  // validation philosophy (see this file's header comment) refuses to
  // silently default. Minimum length is a floor against an accidentally
  // trivial secret, not a claim of full entropy validation.
  JWT_ACCESS_SECRET: z
    .string()
    .min(
      32,
      'JWT_ACCESS_SECRET is required and must be at least 32 characters — the backend ' +
        'cannot start without a real access-token signing secret (see master plan §16, "Secrets").',
    ),

  // Access JWT TTL — master plan §8: "short-lived ... approximately 5–15 minutes".
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),

  // Refresh token TTL — master plan §8: "long-lived (e.g. 30 days)".
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Password reset token TTL — master plan §5.1/§8: "short-lived (e.g. 30-60 min)".
  PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(45),

  // Redis-backed sign-in rate limiting (master plan §8 "Brute-force
  // protection", §16). Per-IP and per-account, both windows independently
  // configurable. Defaults are a reasonable starting point, not a tuned
  // production value — §18's load-testing pass (Phase P18) is where real
  // traffic informs the final numbers.
  AUTH_SIGNIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AUTH_SIGNIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),

  // Redis-backed password-reset-request rate limiting (same rationale).
  AUTH_PASSWORD_RESET_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
});

export type EnvVariables = z.infer<typeof EnvSchema>;

/**
 * Passed to `ConfigModule.forRoot({ validate })`. NestJS calls this once at
 * boot with the raw `process.env` — a thrown error here stops the app from
 * starting, which is exactly the fail-fast behavior wanted for a missing
 * secret or malformed connection string.
 */
export function validateEnv(config: Record<string, unknown>): EnvVariables {
  const parsed = EnvSchema.safeParse(config);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  if (parsed.data.NODE_ENV === 'production') {
    const origins =
      parsed.data.CORS_ALLOWED_ORIGINS?.split(',')
        .map((o) => o.trim())
        .filter(Boolean) ?? [];
    if (origins.length === 0) {
      throw new Error(
        'CORS_ALLOWED_ORIGINS is required when NODE_ENV=production — refusing to start with an ' +
          'implicit/wildcard CORS policy in production (see master plan §16, "CORS").',
      );
    }
  }

  return parsed.data;
}
