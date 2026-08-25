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

  // --- Phase P8 — Media Library & Object Storage (master plan §13, §21 P8, ADR-005) ---
  // Cloudflare R2, S3-compatible — same client/protocol against a local
  // MinIO endpoint in development/test (docker-compose.yml) and the real
  // R2 endpoint in production; only these values differ per environment.
  // All required, no silent default — a missing storage credential is
  // exactly the class of connectivity/security-critical value this file's
  // header comment refuses to default (matches DATABASE_URL/REDIS_URL's
  // own precedent).
  R2_ENDPOINT: z
    .string()
    .min(
      1,
      'R2_ENDPOINT is required — the backend cannot start without an object-storage endpoint.',
    ),
  R2_ACCESS_KEY_ID: z
    .string()
    .min(1, 'R2_ACCESS_KEY_ID is required for object-storage authentication.'),
  R2_SECRET_ACCESS_KEY: z
    .string()
    .min(1, 'R2_SECRET_ACCESS_KEY is required for object-storage authentication.'),
  R2_BUCKET: z
    .string()
    .min(1, 'R2_BUCKET is required — the bucket media assets are stored in.'),
  // R2 itself documents `'auto'` as its recommended region value; MinIO
  // (and most other non-R2 S3-compatible stores) expect a real AWS-style
  // region string instead — `CreateBucketCommand` specifically was
  // confirmed to malform against MinIO with `'auto'` during
  // implementation (routed to `/` instead of `/{bucket}`). One
  // environment-specific value, never a second client implementation.
  R2_REGION: z.string().min(1).default('auto'),
  // The durable, public base URL `media_assets.url` is built from
  // (`{R2_PUBLIC_URL_BASE}/{storage_key}`) — R2's own public bucket URL or
  // custom domain in production; MinIO's local API endpoint in
  // development/test, matching how MinIO also serves objects over HTTP.
  R2_PUBLIC_URL_BASE: z
    .string()
    .min(1, 'R2_PUBLIC_URL_BASE is required to build durable public asset URLs.'),
  // MinIO (and some non-AWS S3-compatible stores) require path-style
  // requests (`endpoint/bucket/key`) instead of AWS's default
  // virtual-hosted style (`bucket.endpoint/key`) — real R2 also documents
  // path-style as its own recommended mode. One flag, defaulted true
  // (the mode every environment this app actually targets uses), never a
  // second storage-provider implementation.
  R2_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // Per-file upload ceiling for the V1 base64-bridge path (master plan
  // §13: "Max file size... enforced server-side explicitly"). No number
  // is specified anywhere in the master plan or frontend contract — 10MB
  // is a reasonable, narrow V1 default for the image/document allowlist
  // this phase supports (video is out of scope entirely, §13 V2), not a
  // tuned production value.
  MEDIA_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),

  // --- Phase P11 — Public Website Runtime, Domains & Edge (master plan
  // §5.11, §21 P11) ---
  // The trusted root domain Atlas subdomains are allocated under (e.g.
  // `atlas.dev` → `harvard.atlas.dev`). Deliberately OPTIONAL with no
  // fake default — matches the real frontend's own `ENV.platformBaseDomain`
  // (`VITE_PLATFORM_BASE_DOMAIN`), which is also optional and never given
  // a fallback value: "no environment today sets this variable" is the
  // frontend's own documented, honest starting state, and the backend
  // mirrors it exactly rather than inventing a domain that doesn't exist.
  PLATFORM_BASE_DOMAIN: z.string().min(1).optional(),

  // Real Cloudflare API credentials (master plan §21 P11: "real
  // Cloudflare API integration"). Deliberately OPTIONAL, unlike R2 above —
  // R2/MinIO always has a real, running endpoint even in local
  // development (docker-compose.yml); no Cloudflare account exists in any
  // environment today (confirmed directly: the real frontend's own
  // `InfrastructureProviderStatus.connected` documents `false` as "the
  // correct, honest value in every environment today"). Absent credentials
  // mean every Cloudflare-backed status genuinely reports
  // `not_configured`/`connected: false` — never a fabricated success.
  CLOUDFLARE_API_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_ZONE_ID: z.string().min(1).optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
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
