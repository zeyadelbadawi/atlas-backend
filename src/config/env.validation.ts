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

  // --- Phase 10 — Error monitoring (Sentry) ---
  // Deliberately OPTIONAL, unlike DATABASE_URL/REDIS_URL. Error reporting
  // is not connectivity-critical: with no DSN configured the integration
  // disables itself completely and the app runs exactly as before, which
  // is what keeps local development, CI and any self-hosted deployment
  // from needing a Sentry project just to boot.
  //
  // A malformed DSN, on the other hand, IS rejected at boot. A
  // silently-broken monitoring pipeline is worse than none, because it
  // looks configured while reporting nothing.
  // Alert routing — the dedicated credential the internal Prometheus uses
  // to scrape `/metrics` (see `MetricsAccessGuard`). Host secret only;
  // unset disables the scrape door. At least 32 characters when set.
  METRICS_SCRAPE_TOKEN: z.string().min(32).optional(),
  // Observability Center — the INTERNAL Prometheus / Alertmanager the
  // Platform Owner pages read from. Deployment-provided only; never taken
  // from a request. Unset = the pages say "not configured".
  PROMETHEUS_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional(),
  ),
  ALERTMANAGER_URL: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().url().optional(),
  ),

  SENTRY_DSN: z
    .string()
    .refine((value) => value === '' || /^https:\/\/[^@]+@[^/]+\/\d+$/.test(value), {
      message:
        'SENTRY_DSN must be a Sentry DSN of the form https://<key>@<host>/<project-id>, or be omitted entirely to disable error reporting.',
    })
    .optional(),

  /** Fraction of transactions sampled for performance monitoring. `0` (the default) keeps tracing off, so configuring a DSN alone never silently starts sending performance data or incurring quota. */
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

  /** Distinguishes production from staging in the Sentry UI. Falls back to NODE_ENV when unset. */
  SENTRY_ENVIRONMENT: z.string().optional(),

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

  // Phase 10.1 — email-verification link lifetime. Deliberately much
  // longer than a password reset (24h vs 45m): a signup email is
  // routinely opened hours later, and unlike a reset link this token
  // grants no account access on its own — it only marks an address as
  // deliverable. It is still single-use and still expires.
  EMAIL_VERIFICATION_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(1440),

  // Phase 10.1 — whether registration performs the DNS deliverability
  // lookup. Left unset it follows NODE_ENV (off in `test`, on everywhere
  // else); see `IdentityConfig.emailDeliverabilityCheckEnabled`. The
  // disposable-domain list is a separate, local check and is NEVER
  // disabled by this flag.
  // P6 — real-user monitoring ingestion (`POST /rum/vitals`). Off unless
  // exactly "true"; the frontend also samples nothing unless its build
  // sets VITE_RUM_SAMPLE_RATE. Reports/REAL_USER_MONITORING.md.
  RUM_ENABLED: z.union([z.literal('true'), z.literal('false')]).optional(),

  EMAIL_DELIVERABILITY_CHECK_ENABLED: z
    .union([z.literal('true'), z.literal('false')])
    .transform((value) => value === 'true')
    .optional(),

  // Redis-backed sign-in rate limiting (master plan §8 "Brute-force
  // protection", §16). Per-IP and per-account, both windows independently
  // configurable. Defaults are a reasonable starting point, not a tuned
  // production value — §18's load-testing pass (Phase P18) is where real
  // traffic informs the final numbers.
  AUTH_SIGNIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  AUTH_SIGNIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  // ATO review F7 — lockout-resistant sign-in throttling.
  AUTH_SIGNIN_RATE_LIMIT_IP_MAX: z.coerce.number().int().positive().default(30),
  AUTH_SIGNIN_ACCOUNT_FAILURE_CEILING: z.coerce.number().int().positive().default(50),
  AUTH_SIGNIN_ACCOUNT_FAILURE_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),

  // Redis-backed password-reset-request rate limiting (same rationale).
  AUTH_PASSWORD_RESET_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),

  // `POST /auth/verify-email/resend` — sends mail on demand, so it has its
  // own counters rather than borrowing password reset's (which let one
  // flow exhaust the other's budget). Per ACCOUNT (3/hour: a person needs
  // one link, two if the first went to spam) and per client IP (20/hour:
  // looser, because a campus or office NAT puts many learners behind one
  // address, and the per-account key is what actually stops one account
  // being used to flood its own mailbox).
  AUTH_EMAIL_VERIFICATION_RESEND_RATE_LIMIT_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(3),
  AUTH_EMAIL_VERIFICATION_RESEND_IP_RATE_LIMIT_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(20),
  AUTH_EMAIL_VERIFICATION_RESEND_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),

  // --- Phase P18 — Production Hardening (master plan §16/§21 P18) ---
  // `POST /auth/register` had no dedicated rate limit before this phase —
  // only the generic global 120-req/min-per-IP default (§0's own P18
  // audit finding). Bulk fake-account creation is a real, distinct abuse
  // pattern from repeated sign-in attempts, so it gets its own budget. It
  // is deliberately NOT as tight as an initial 5/hour draft: registration
  // is IP-only (no account yet exists to scope a second key to, unlike
  // sign-in's combined IP+account check), and IP-only budgets are shared by
  // everyone behind the same NAT/campus/office network — a real, legitimate
  // school or coworking space can plausibly onboard more than 5 accounts
  // from one IP within an hour. 20/hour still meaningfully blocks bulk
  // automated account creation (which wants hundreds, not tens) while
  // comfortably covering that legitimate case. (Also confirmed against this
  // repo's own e2e suite: the heaviest single legitimate multi-actor test
  // flow — `course-commerce.e2e-spec.ts`'s commission-snapshot scenario —
  // creates 6 real accounts in one test run; a production-realistic limit
  // must clear real usage like that, not just an arbitrary round number.)
  // Same Redis-backed fixed-window mechanism as sign-in/password-reset
  // (`AuthRateLimiterService`) — no second rate-limiting architecture
  // introduced.
  AUTH_REGISTER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  AUTH_REGISTER_RATE_LIMIT_WINDOW_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),

  // --- P64 Communications C4 (§12) — email OTP and trusted devices ---
  // The two mode switches are the staged rollout of §50 (`off` ->
  // management -> academies) and default to `off` on both surfaces: an
  // unset variable must never be the reason production starts demanding
  // an emailed code. They gate whether an ADDITIONAL factor is asked for;
  // no value of them removes or weakens an existing control.
  FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT: z
    .enum(['off', 'new_device', 'always'])
    .default('off'),
  FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY: z
    .enum(['off', 'new_device', 'always'])
    .default('off'),
  // ATO review F11 — the emailed-code floor for privileged management
  // sign-ins without an authenticator app (see `EmailOtpConfig.privilegedFloor`).
  AUTH_PRIVILEGED_EMAIL_OTP_FLOOR: z
    .enum(['off', 'new_device', 'always'])
    .default('new_device'),
  // ATO review F10 — absolute session lifetimes (days from sign-in).
  SESSION_ABSOLUTE_MAX_DAYS_MANAGEMENT: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .optional(),
  SESSION_ABSOLUTE_MAX_DAYS_ACADEMY: z.coerce.number().int().min(1).max(365).optional(),
  // ATO review F11 — when Platform Owners must have an authenticator app
  // (ISO 8601 instant), or `never`.
  PLATFORM_OWNER_TOTP_REQUIRED_FROM: z
    .string()
    .refine((value) => value === 'never' || !Number.isNaN(Date.parse(value)), {
      message: 'must be an ISO 8601 date-time or "never"',
    })
    .optional(),
  // New Customer Onboarding — docs/NEW_CUSTOMER_ONBOARDING.md §2.
  FLAG_SIGNUP_ORGANIZATION_MODE: z.enum(['off', 'on']).default('off'),
  // Google Identity (docs/GOOGLE_IDENTITY.md). `off` (default): every
  // `/auth/google/*` route answers 404 and the sign-in pages offer no Google
  // button. `allowlist`: academy websites in FLAG_AUTH_GOOGLE_ACADEMY_IDS
  // only (the management surface stays off unless FLAG_AUTH_GOOGLE_PLATFORM
  // is `on`). `on`: every surface. No value changes password sign-in, the
  // emailed code or trusted devices.
  FLAG_AUTH_GOOGLE_MODE: z.enum(['off', 'allowlist', 'on']).default('off'),
  FLAG_AUTH_GOOGLE_ACADEMY_IDS: z.string().optional(),
  // `allowlist` mode only: `on` also offers Google on Atlas's own sign-in and
  // sign-up pages (the platform host — the management surface), through the
  // same pipeline (TOTP, emailed code, surface rules). Ignored by `off`/`on`.
  FLAG_AUTH_GOOGLE_PLATFORM: z.enum(['off', 'on']).default('off'),

  // --- P64 Communications C5 (§26/§27, §43) — tenant lifecycle sequences ---
  // `off` (the default) evaluates nothing; `dry_run` evaluates every
  // condition and logs the steps it WOULD emit, which is how the first
  // production cycle is meant to be watched; `on` sends. Defaulting to
  // `off` follows the same rule as the OTP switches above: an unset
  // variable must never be the reason production starts emailing
  // customers about their subscription.
  FLAG_LIFECYCLE_SEQUENCES_MODE: z.enum(['off', 'dry_run', 'on']).default('off'),

  // --- P64 Communications C6 (§31/§32, §43) — hosted-video retention ---
  // The only flag in this codebase whose `on` value DESTROYS CUSTOMER
  // DATA, so it has one more setting than C5's and a stricter default.
  //
  //   `off`       (the default) — evaluates nothing, sends nothing,
  //               deletes nothing. An unset variable must never be the
  //               reason a customer's video is deleted.
  //   `warn_only` — evaluates everything and sends the full W1-W4 warning
  //               sequence, and DELETES NOTHING. This is not a dry run:
  //               the warnings are real mail to real customers. It is the
  //               intended production state for at least one full
  //               retention window, so that the deletion step, when it is
  //               finally enabled, can only reach tenants who have
  //               already received all four notices (see the warning
  //               precondition in `video-retention.util.ts`).
  //   `on`        — the warnings, and the deletion.
  //
  // There is deliberately no mode that deletes without warning.
  FLAG_VIDEO_RETENTION_MODE: z.enum(['off', 'warn_only', 'on']).default('off'),
  // Archived-media purge (owner decision, 26 Sep 2026: 30-day grace, then
  // permanent deletion). `dry_run` finds and logs what WOULD be destroyed
  // and destroys nothing; `on` destroys. Defaults to `dry_run` so a
  // deploy never starts deleting customer bytes on its own.
  FLAG_MEDIA_ARCHIVE_PURGE_MODE: z.enum(['off', 'dry_run', 'on']).default('dry_run'),
  // §12's approved numbers. Configurable so a load-testing pass can tune
  // them, bounded so a typo cannot turn the control off: the ceiling on
  // attempts and codes is validated as a positive integer, and the code
  // lifetime is capped at an hour.
  AUTH_EMAIL_OTP_CODE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3600)
    .default(600),
  AUTH_EMAIL_OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(5),
  AUTH_EMAIL_OTP_MAX_CODES: z.coerce.number().int().positive().max(10).default(3),
  AUTH_EMAIL_OTP_RESEND_COOLDOWN_SECONDS: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(3600)
    .default(60),
  AUTH_EMAIL_OTP_CHALLENGES_PER_HOUR: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .default(5),
  // §12: 90 days for staff, 180 for learners. 1-365, matching the range
  // the platform communication-settings contract exposes.
  AUTH_TRUSTED_DEVICE_DAYS_MANAGEMENT: z.coerce
    .number()
    .int()
    .positive()
    .max(365)
    .default(90),
  AUTH_TRUSTED_DEVICE_DAYS_ACADEMY: z.coerce
    .number()
    .int()
    .positive()
    .max(365)
    .default(180),

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

  // --- P64 Phase 2 — protected content tier and provider-hosted video
  // (master plan Phase 2 §D.1/§D.4) ---
  //
  // Every one of these is optional with a working default, because the
  // phase has to boot in an environment that has no Cloudflare Stream
  // account — the same honest posture `ZOOM_*` already takes. What must
  // NOT have a permissive default is the protected bucket name: it falls
  // back to `<R2_BUCKET>-protected` in `configuration.ts`, so an unset
  // variable still means a genuinely separate bucket, never the public one.
  // The five P64 Phase 2 rollout flags (§S). Same three modes as
  // `SURFACE_ENFORCE_MODE`, defaulting to `off` — see
  // `FeatureFlagsService` for why `off` is the safe end for each of them.
  FLAG_CONTENT_PROTECTED_MODE: z.enum(['off', 'allowlist', 'on']).default('off'),
  FLAG_CONTENT_PROTECTED_ACADEMY_IDS: z.string().optional(),
  FLAG_VIDEO_NORMAL_MODE: z.enum(['off', 'allowlist', 'on']).default('off'),
  FLAG_VIDEO_NORMAL_ACADEMY_IDS: z.string().optional(),
  FLAG_VIDEO_PREMIUM_MODE: z.enum(['off', 'allowlist', 'on']).default('off'),
  FLAG_VIDEO_PREMIUM_ACADEMY_IDS: z.string().optional(),
  // P64 Phase 3 (§S): quiz engine v2 (timer, windows, shuffle, autosave
  // deadlines), the integrity layer (defaults to recording nothing until an
  // author turns a quiz's mode on) and certificates.
  FLAG_QUIZ_ENGINE_V2_MODE: z.enum(['off', 'allowlist', 'on']).default('off'),
  FLAG_QUIZ_ENGINE_V2_ACADEMY_IDS: z.string().optional(),
  FLAG_QUIZ_INTEGRITY_MODE: z.enum(['off', 'allowlist', 'on']).default('off'),
  FLAG_QUIZ_INTEGRITY_ACADEMY_IDS: z.string().optional(),
  // P64 Phase 3 (§D.6): certificate download links are a distinct purpose
  // from lesson-content presigns (10 min) — one hour, capped at one hour.
  CERTIFICATE_LINK_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(3600),
  // Prisma interactive-transaction limits. The defaults are Prisma's own
  // (5 s / 2 s); CI raises the timeout because the shared runner's
  // database is slow enough for the seed-heavy suites to trip 5 s and
  // answer 500 where the test expects a real outcome.
  PRISMA_INTERACTIVE_TX_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(120_000)
    .default(5000),
  PRISMA_INTERACTIVE_TX_MAX_WAIT_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(60_000)
    .default(2000),

  R2_PROTECTED_BUCKET: z.string().trim().min(1).optional(),
  /*
    Credentials for the PROTECTED bucket alone.

    Optional, and absent they fall back to `R2_ACCESS_KEY_ID` /
    `R2_SECRET_ACCESS_KEY`, which is the behaviour every environment had
    before these existed — so an environment that never sets them is
    unaffected.

    They exist because the protected bucket is the one place a token
    scoped to a SINGLE bucket is worth having: an R2 token restricted to
    the protected bucket cannot read or write the public media bucket, so
    a leak of the protected credential cannot reach customer avatars,
    thumbnails or course images, and vice versa. Sharing one token across
    both buckets would make either leak total.

    Both must be set together to take effect — a half-configured pair is
    rejected below rather than silently falling back, because "I set the
    key id and protected media is still using the public token" is
    exactly the kind of failure nobody notices.
  */
  R2_PROTECTED_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  R2_PROTECTED_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
  PROTECTED_MEDIA_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    // 10 minutes (Phase 2 §I). Capped as well as defaulted: a presigned
    // URL is a bearer credential, and an operator who typed 86400 would be
    // turning it back into the durable link this phase exists to remove.
    .max(3600)
    .default(600),
  PROTECTED_MEDIA_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  // W6 — the largest Normal-tier video a presigned PUT may store. 5 GiB is
  // also S3/R2's own single-PUT maximum, so it is the ceiling as well.
  VIDEO_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024 * 1024)
    .default(5 * 1024 * 1024 * 1024),
  VIDEO_PROVIDER: z.enum(['fake', 'cloudflare_stream', 'r2_worker']).default('fake'),
  // P64 Phase 2 (DL-19) — the NORMAL tier's delivery gate. Optional: the
  // tier reports itself unconfigured without them rather than failing
  // startup, because an environment may legitimately run Premium only.
  BASIC_VIDEO_DELIVERY_HOST: z.string().trim().optional(),
  BASIC_VIDEO_SIGNING_SECRET: z.string().trim().optional(),
  // Revocation and origin restriction are CAPABILITIES the grant reports
  // to the learner, so they are driven by whether they are actually
  // configured — never assumed (AD-16).
  BASIC_VIDEO_REVOCATION_ENDPOINT: z.string().trim().optional(),
  BASIC_VIDEO_REVOCATION_TOKEN: z.string().trim().optional(),
  BASIC_VIDEO_ALLOWED_ORIGINS_CONFIGURED: z.enum(['true', 'false']).default('false'),
  BASIC_VIDEO_PLAYBACK_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    // Capped at one hour, like every other credential ceiling here: the
    // Normal tier's short credential IS its revocation mechanism, and an
    // operator who typed 86400 would be removing it.
    .max(3600)
    .default(600),
  CLOUDFLARE_STREAM_ACCOUNT_ID: z.string().trim().optional(),
  CLOUDFLARE_STREAM_API_TOKEN: z.string().trim().optional(),
  CLOUDFLARE_STREAM_SIGNING_KEY_ID: z.string().trim().optional(),
  CLOUDFLARE_STREAM_SIGNING_KEY_PEM: z.string().optional(),
  CLOUDFLARE_STREAM_WEBHOOK_SECRET: z.string().trim().optional(),
  CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN: z.string().trim().optional(),
  VIDEO_PLAYBACK_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    // W5 — 10 minutes by default, the same life the Normal tier's gate
    // token and every protected-file presign already have. The token is an
    // unbound bearer credential (Stream cannot tie it to a session or
    // device), so its lifetime IS its revocation window. The learner player
    // refreshes the grant at 70% of the credential's remaining life and
    // swaps the source when the attached one expires (atlas
    // `useLessonGrant`/`useVideoSource`), so a short token costs one
    // position-preserving re-attach per period, never a dead video.
    // The 2-hour ceiling is kept only so an environment that still sets the
    // old value explicitly keeps booting; it should be unset.
    .max(2 * 60 * 60)
    .default(10 * 60),
  LEARNING_LEASE_TTL_SECONDS: z.coerce.number().int().positive().max(600).default(60),
  // W2 — how long a non-terminal provisioning request may go without any
  // step starting, finishing or failing before the status endpoint reports
  // it `stalled` (and the UI offers Retry). A real run takes seconds.
  PROVISIONING_STALL_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
  LEARNING_LEASE_HEARTBEAT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(300)
    .default(20),

  // --- Phase P11 — Public Website Runtime, Domains & Edge (master plan
  // §5.11, §21 P11) ---
  // The trusted root domain Atlas subdomains are allocated under (e.g.
  // `atlas.dev` → `harvard.atlas.dev`). Deliberately OPTIONAL with no
  // fake default — matches the real frontend's own `ENV.platformBaseDomain`
  // (`VITE_PLATFORM_BASE_DOMAIN`), which is also optional and never given
  // a fallback value: "no environment today sets this variable" is the
  // frontend's own documented, honest starting state, and the backend
  // mirrors it exactly rather than inventing a domain that doesn't exist.
  // P63g — shape-validated and lowercased: this value is the suffix every
  // subdomain is matched against, the CORS allow-rule and the HSTS scope.
  PLATFORM_BASE_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
      'PLATFORM_BASE_DOMAIN must be a bare hostname (no scheme, port or trailing dot)',
    )
    .optional(),

  // --- P64 Phase 1: surface-enforcement rollout control ---
  //
  // Rollout control for the management-surface refusal, NOT a security
  // boundary: `ManagementSurfaceGuard` and the RLS policies stay in force
  // in every mode. `on` is the default and the end state; `allowlist`
  // refuses only learners of the listed academies (the plan's staged
  // rollout); `off` restores the pre-P64 behaviour for an instant
  // rollback. An invalid value fails startup rather than being silently
  // treated as `off` — a typo must never quietly disable the refusal.
  SURFACE_ENFORCE_MODE: z.enum(['off', 'allowlist', 'on']).optional(),

  // Comma-separated academy ids; only read while the mode is `allowlist`.
  SURFACE_ENFORCE_ACADEMY_IDS: z.string().trim().optional(),

  // --- Zoom (Live Sessions add-on) ---
  //
  // ATLAS OWNS THE ZOOM APPLICATION. These are Atlas's own General OAuth
  // app credentials, not a customer's — customers never create Zoom apps
  // and never see these values. Every one of them is DELIBERATELY
  // OPTIONAL, for the same reason `PLATFORM_BASE_DOMAIN` and the
  // Cloudflare block are: no real Zoom application exists in any Atlas
  // environment yet. The backend must boot, and every other feature must
  // keep working, with Zoom entirely unconfigured — the Live Sessions
  // connection screen then reports "not configured" honestly rather than
  // the process refusing to start.
  ZOOM_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  ZOOM_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  // The redirect URI is configured EXPLICITLY rather than derived from a
  // base domain. Zoom matches it byte-for-byte against the value
  // registered in the Marketplace app, so a value assembled from parts is
  // a silent-mismatch waiting to happen — one that fails only at the
  // moment a real customer tries to connect.
  ZOOM_OAUTH_REDIRECT_URI: z.string().url().optional(),
  // ONE app-level secret for ALL customer accounts. Zoom issues a single
  // Secret Token per application; webhook signatures are verified with it
  // BEFORE any tenant is looked up.
  ZOOM_WEBHOOK_SECRET_TOKEN: z.string().min(1).optional(),
  // Meeting SDK app credentials — Atlas-owned, moved here from per-academy
  // storage so the S2S credential form can be removed. No SDK BEHAVIOUR
  // changes with this: the signature is built exactly as before, only the
  // source of the key/secret moves.
  ZOOM_SDK_KEY: z.string().min(1).optional(),
  ZOOM_SDK_SECRET: z.string().min(1).optional(),

  // Google Identity — ONE Atlas-owned OAuth client for every surface and
  // every academy host (custom domains included): the redirect URI is the
  // single central callback on the platform host, configured explicitly
  // for the same byte-for-byte reason as ZOOM_OAUTH_REDIRECT_URI. Optional:
  // the backend boots without Google, and FLAG_AUTH_GOOGLE_MODE may only
  // leave `off` once all three are set (checked below).
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url().optional(),
  // TEST/LOCAL ONLY — point the OpenID Connect client at a local fake
  // provider. Refused in production (below): the issuer, endpoints and
  // signing keys of the real Google are compiled in.
  GOOGLE_OIDC_ISSUER: z.string().url().optional(),
  GOOGLE_OIDC_AUTHORIZATION_ENDPOINT: z.string().url().optional(),
  GOOGLE_OIDC_TOKEN_ENDPOINT: z.string().url().optional(),
  GOOGLE_OIDC_JWKS_URI: z.string().url().optional(),

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
  // P63g — Cloudflare zone ids are 32 hex characters; anything else is a
  // configuration mistake that would otherwise surface as confusing 404s.
  CLOUDFLARE_ZONE_ID: z
    .string()
    .regex(/^[0-9a-f]{32}$/i, 'CLOUDFLARE_ZONE_ID must be a 32-character hex zone id')
    .optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),

  // --- Phase P12 — Atlas Subscription Billing (master plan §5.7, §12,
  // §16, §21 P12) ---
  // HMAC signing secret `PaymentWebhookController` verifies every inbound
  // payment-provider webhook against (§16: "HMAC signature verification on
  // every inbound payment/provider webhook"). Unlike `CLOUDFLARE_API_TOKEN`
  // (no real Cloudflare account exists in any environment) this secret is
  // NOT third-party-account-dependent — Atlas itself controls both ends of
  // this contract (it's the value a future gateway adapter would be
  // configured with, exactly like `JWT_ACCESS_SECRET`'s own "dev-only,
  // locally generated" precedent) — so it is required, not optional, and
  // has the same minimum-length floor. No real gateway calls this endpoint
  // in this phase (master plan §21 P12: "not yet connected") — its own
  // e2e/idempotency tests sign synthetic events with this exact secret,
  // proving the verification/idempotency logic deterministically without a
  // live external provider.
  PAYMENT_WEBHOOK_SECRET: z
    .string()
    .min(
      32,
      'PAYMENT_WEBHOOK_SECRET is required and must be at least 32 characters — the backend ' +
        'cannot start without a real webhook signing secret (see master plan §16, "Webhook verification").',
    ),

  // --- Organization Payment Configuration (master plan §5.8, §16;
  // product decisions §4.1/§4.2, 2026-08-26) ---
  // Symmetric key `CredentialEncryptionService` uses to envelope-encrypt
  // `organization_gateway_credentials.encrypted_config` before it is ever
  // written to the database (AES-256-GCM — 32 raw key bytes, hex-encoded,
  // so exactly 64 hex characters). Required, no default — this is exactly
  // the class of connectivity/security-critical secret this file's header
  // comment refuses to silently default (same bar as JWT_ACCESS_SECRET/
  // PAYMENT_WEBHOOK_SECRET), and it is security-critical from the moment
  // this column exists, even though no real gateway is integrated yet —
  // an Organization can already attempt to save its own gateway
  // configuration in this phase.
  PAYMENT_CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .length(
      64,
      'PAYMENT_CREDENTIALS_ENCRYPTION_KEY is required and must be exactly 64 hex characters ' +
        '(32 raw bytes) — the backend cannot start without a real AES-256-GCM key for ' +
        'encrypting organization-owned gateway credentials at rest (see master plan §16).',
    )
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'PAYMENT_CREDENTIALS_ENCRYPTION_KEY must be a 64-character hex string (32 raw bytes).',
    ),

  // W8 — optional dedicated key for the customer-identity HMAC (trial and
  // gifted-days ledgers). When unset, the key is HKDF-derived from
  // PAYMENT_CREDENTIALS_ENCRYPTION_KEY under a fixed label (the same
  // derivation pattern as the TOTP/OTP ciphers). NEVER rotate whichever
  // source is in use once v2 ledger rows exist: a changed key silently
  // re-grants every trial and gift (see customer-identity-key.util.ts).
  CUSTOMER_IDENTITY_HMAC_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'CUSTOMER_IDENTITY_HMAC_KEY must be a 64-character hex string (32 raw bytes).',
    )
    .optional(),
  // ATO review F7 — optional dedicated key for the known-device sign-in
  // cookie; derived from PAYMENT_CREDENTIALS_ENCRYPTION_KEY when unset.
  SIGNIN_DEVICE_COOKIE_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'SIGNIN_DEVICE_COOKIE_KEY must be a 64-character hex string.',
    )
    .optional(),
  // ATO review key separation — optional dedicated key for one-click
  // unsubscribe links; derived from PAYMENT_CREDENTIALS_ENCRYPTION_KEY when
  // unset. No longer tied to JWT_ACCESS_SECRET.
  UNSUBSCRIBE_TOKEN_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'UNSUBSCRIBE_TOKEN_KEY must be a 64-character hex string.',
    )
    .optional(),

  // --- Phase P17 — Notifications, Email & Search (master plan §12
  // "Transactional email", §21 P17) ---
  // Which `EmailProvider` implementation `EmailModule`'s DI factory wires
  // up (`identity.module.ts`'s own `EMAIL_PROVIDER` token). Defaults to
  // `'stub'` — no real transactional-email account exists in any
  // environment today, the same "optional, no fake default" honesty
  // `CLOUDFLARE_API_TOKEN`'s own doc comment already established for a
  // third-party account this codebase doesn't yet have. `'resend'` is the
  // one real, simple-HTTP-API provider this phase wires (see
  // `resend-email.provider.ts`'s own doc comment for why Resend).
  // P64 Communications — `EMAIL_PROVIDER` is now the SINGLE-PROVIDER
  // ALIAS of `EMAIL_PROVIDERS` (kept so every existing env keeps working).
  EMAIL_PROVIDER: z.enum(['stub', 'resend', 'brevo']).default('stub'),
  // P64 Communications — the ordered fallback chain the
  // `EmailProviderRegistry` tries (comma list of `stub|brevo|resend`, e.g.
  // `brevo,resend`: Brevo PRIMARY, Resend FALLBACK — the approved
  // production shape). Unset → `[EMAIL_PROVIDER]`.
  EMAIL_PROVIDERS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(['stub', 'resend', 'brevo'])).min(1))
    .optional(),
  // Per-provider keys. `EMAIL_API_KEY` is the LEGACY Resend key (P17) and
  // is still accepted as a fallback for `RESEND_API_KEY`. A real provider
  // listed without its key or without `EMAIL_FROM_EMAIL` refuses to boot
  // (checked in `validateEnv` below, the same cross-field precedent as
  // NODE_ENV=production → CORS_ALLOWED_ORIGINS).
  EMAIL_API_KEY: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  BREVO_API_KEY: z.string().min(1).optional(),
  // Sender identity: the owner's single-sender-verified address (no domain
  // DNS) — the same value on every provider.
  EMAIL_FROM_EMAIL: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().min(1).default('Atlas'),
  EMAIL_REPLY_TO: z.string().email().optional(),
  // Inbound delivery-webhook authentication. Brevo has no HMAC: the secret
  // travels in the webhook URL (`?secret=`). Resend signs via Svix
  // (`whsec_...`). Unset → that provider's webhook endpoint refuses
  // everything (fail closed).
  BREVO_WEBHOOK_SECRET: z.string().min(16).optional(),
  RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),

  // --- P64 Communications ---
  // The platform web app's public origin, used by the email link builder
  // for platform-branded links (billing, dashboard, account). Defaults to
  // the local Vite origin outside production; REQUIRED in production
  // (checked in `validateEnv` below) because an email link built from a
  // localhost default would be a broken link in a real inbox. Never read
  // from a request header.
  PLATFORM_WEB_URL: z.string().trim().url().optional(),
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

  // Google Identity — never switched on half-configured, and never pointed
  // at anything but the real Google in production.
  if (parsed.data.FLAG_AUTH_GOOGLE_MODE !== 'off') {
    const missing = (
      [
        'GOOGLE_OAUTH_CLIENT_ID',
        'GOOGLE_OAUTH_CLIENT_SECRET',
        'GOOGLE_OAUTH_REDIRECT_URI',
      ] as const
    ).filter((key) => !parsed.data[key]);
    if (missing.length > 0) {
      throw new Error(
        `FLAG_AUTH_GOOGLE_MODE=${parsed.data.FLAG_AUTH_GOOGLE_MODE} requires ${missing.join(', ')} — refusing to start with Google sign-in half-configured.`,
      );
    }
  }
  if (
    parsed.data.NODE_ENV === 'production' &&
    (parsed.data.GOOGLE_OIDC_ISSUER ||
      parsed.data.GOOGLE_OIDC_AUTHORIZATION_ENDPOINT ||
      parsed.data.GOOGLE_OIDC_TOKEN_ENDPOINT ||
      parsed.data.GOOGLE_OIDC_JWKS_URI)
  ) {
    throw new Error(
      'GOOGLE_OIDC_* endpoint overrides are for local/test fake providers only — refusing to start in production.',
    );
  }

  // P63g — half-configured Cloudflare credentials used to pass the token
  // check and then fail every custom-domain call one by one. Both or none.
  if (
    Boolean(parsed.data.CLOUDFLARE_API_TOKEN) !== Boolean(parsed.data.CLOUDFLARE_ZONE_ID)
  ) {
    throw new Error(
      'CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID must be set together — refusing to start ' +
        'with a token but no zone (or a zone but no token) for the custom-domain integration.',
    );
  }

  // P64 Phase 2 — the protected-bucket credentials are the same "both or
  // none" shape, for a sharper reason than the pair above: a key id with
  // no secret does not fail, it FALLS BACK to the public media token and
  // keeps working. The bucket isolation an operator thought they had
  // would be silently absent, and nothing would say so.
  if (
    Boolean(parsed.data.R2_PROTECTED_ACCESS_KEY_ID) !==
    Boolean(parsed.data.R2_PROTECTED_SECRET_ACCESS_KEY)
  ) {
    throw new Error(
      'R2_PROTECTED_ACCESS_KEY_ID and R2_PROTECTED_SECRET_ACCESS_KEY must be set together — ' +
        'refusing to start with half a protected-bucket credential, which would silently fall ' +
        'back to the public media token and lose the isolation those variables exist to provide.',
    );
  }

  // W15 — the protected tier exists to keep lesson files, submissions and
  // video out of the publicly-served bucket. Pointing it at that same
  // bucket boots fine and silently publishes everything it was meant to
  // protect through `public/media`, so it is refused here instead.
  if (
    parsed.data.R2_PROTECTED_BUCKET &&
    parsed.data.R2_PROTECTED_BUCKET.toLowerCase() ===
      parsed.data.R2_BUCKET.trim().toLowerCase()
  ) {
    throw new Error(
      'R2_PROTECTED_BUCKET must not be the same bucket as R2_BUCKET — refusing to start with ' +
        'protected content stored in the publicly-served media bucket.',
    );
  }

  // P64 Phase 2 — selecting the real video provider without the credentials
  // to sign a playback token would boot an app that accepts uploads and
  // then refuses every play. Fail at startup instead, where an operator
  // sees it, rather than per-request where a learner does.
  if (parsed.data.VIDEO_PROVIDER === 'cloudflare_stream') {
    const missing = (
      [
        ['CLOUDFLARE_STREAM_ACCOUNT_ID', parsed.data.CLOUDFLARE_STREAM_ACCOUNT_ID],
        ['CLOUDFLARE_STREAM_API_TOKEN', parsed.data.CLOUDFLARE_STREAM_API_TOKEN],
        [
          'CLOUDFLARE_STREAM_SIGNING_KEY_ID',
          parsed.data.CLOUDFLARE_STREAM_SIGNING_KEY_ID,
        ],
        [
          'CLOUDFLARE_STREAM_SIGNING_KEY_PEM',
          parsed.data.CLOUDFLARE_STREAM_SIGNING_KEY_PEM,
        ],
        [
          'CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN',
          parsed.data.CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN,
        ],
        // Required, not optional: without it every inbound webhook fails
        // signature verification, so no upload is ever reconciled and
        // every reservation keeps consuming quota. See
        // `CloudflareStreamProvider.isConfigured`.
        [
          'CLOUDFLARE_STREAM_WEBHOOK_SECRET',
          parsed.data.CLOUDFLARE_STREAM_WEBHOOK_SECRET,
        ],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `VIDEO_PROVIDER=cloudflare_stream requires ${missing.join(', ')} — refusing to start ` +
          'with the real video provider selected but no credentials to sign playback with.',
      );
    }
  }

  // PLATFORM_WEB_URL is where an email's links point. It must never fall
  // back to a localhost default in production — but requiring it outright
  // would refuse to start every existing deployment, none of which sets
  // it, for a value Atlas can already derive: the platform host IS
  // `PLATFORM_BASE_DOMAIN`, which production has had since P63. So the
  // rule is "derive it, or refuse" rather than "demand it": an explicit
  // value still wins (a separate marketing host, a staging origin), and a
  // deployment with neither is the only one that cannot build a link and
  // is refused.
  const emailProviders = parsed.data.EMAIL_PROVIDERS ?? [parsed.data.EMAIL_PROVIDER];
  const canActuallySend = emailProviders.some((provider) => provider !== 'stub');

  if (parsed.data.NODE_ENV === 'production' && !parsed.data.PLATFORM_WEB_URL) {
    if (parsed.data.PLATFORM_BASE_DOMAIN) {
      parsed.data.PLATFORM_WEB_URL = `https://${parsed.data.PLATFORM_BASE_DOMAIN}`;
    } else if (canActuallySend) {
      // Only a deployment that can actually SEND is refused — i.e. one
      // with a real provider anywhere in `EMAIL_PROVIDERS`, not just in
      // the legacy singular alias. A localhost link inside a real email
      // is a broken product; a deployment on the stub alone sends
      // nothing, so there is no bad link to protect anyone from and no
      // reason to keep it from starting.
      throw new Error(
        'PLATFORM_WEB_URL or PLATFORM_BASE_DOMAIN is required when NODE_ENV=production and a ' +
          'real email provider is configured — refusing to send email links that would point ' +
          'at a localhost default.',
      );
    }
  }

  if (emailProviders.includes('resend')) {
    const resendKey = parsed.data.RESEND_API_KEY ?? parsed.data.EMAIL_API_KEY;
    if (!resendKey || !parsed.data.EMAIL_FROM_EMAIL) {
      throw new Error(
        'RESEND_API_KEY (or legacy EMAIL_API_KEY) and EMAIL_FROM_EMAIL are required when resend is ' +
          'listed in EMAIL_PROVIDERS/EMAIL_PROVIDER — refusing to start with a real provider ' +
          'selected but no credentials/sender to actually send from.',
      );
    }
  }
  if (emailProviders.includes('brevo')) {
    if (!parsed.data.BREVO_API_KEY || !parsed.data.EMAIL_FROM_EMAIL) {
      throw new Error(
        'BREVO_API_KEY and EMAIL_FROM_EMAIL are required when brevo is listed in ' +
          'EMAIL_PROVIDERS/EMAIL_PROVIDER — refusing to start with a real provider selected ' +
          'but no credentials/sender to actually send from.',
      );
    }
  }

  return parsed.data;
}
