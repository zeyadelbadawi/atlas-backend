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

  // Comma-separated allowed origins. Required (non-empty, no wildcard) in
  // production; optional in development/test, where a permissive localhost
  // default is used instead — see `parseCorsOrigins` in configuration.ts.
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
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
