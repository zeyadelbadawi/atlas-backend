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

/**
 * Phase 10 — error monitoring. `dsn` is `undefined` when unconfigured,
 * and that is a supported, fully-functional state: `initializeSentry`
 * no-ops and nothing is ever transmitted.
 */
export interface ObservabilityConfig {
  readonly sentryDsn?: string;
  readonly sentryTracesSampleRate: number;
  readonly sentryEnvironment: string;
}

/** Phase P8 — Media Library & Object Storage configuration (master plan §13, ADR-005). */
export interface MediaStorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly publicUrlBase: string;
  readonly forcePathStyle: boolean;
  readonly maxUploadBytes: number;
}

/** Phase P11 — Public Website Runtime, Domains & Edge configuration (master plan §5.11, §21 P11). `baseDomain` and every Cloudflare field are deliberately optional — no real platform domain or Cloudflare account exists in any environment today (see `env.validation.ts`'s doc comment on `PLATFORM_BASE_DOMAIN`/`CLOUDFLARE_*`). */
export interface PlatformDomainRuntimeConfig {
  readonly baseDomain?: string;
}

/**
 * P64 Phase 1 (master plan Phase 1 §T) — staged rollout control for the
 * surface boundary, and ONLY for that boundary.
 *
 * `ManagementSurfaceGuard` and every RLS policy are the security boundary;
 * this flag decides how widely the *surface refusal* is switched on while
 * it rolls out, exactly as the plan requires ("staged by allowlist —
 * internal academy first, then global within one week"). It can never
 * grant a learner anything RLS or another guard would refuse: a learner
 * admitted here still holds only their own rows, still cannot read another
 * tenant, and every other authorization check runs unchanged. What it
 * changes is whether a learner is refused the management SURFACE at all.
 *
 * Read from configuration only — never from a header, a query parameter or
 * anything else a caller controls.
 *
 * - `on` (default): refuse every learner. The end state.
 * - `allowlist`: refuse only learners who belong to a listed academy.
 * - `off`: refuse nobody — the pre-P64 behaviour, for the first minutes of
 *   a rollout and for an instant rollback without a redeploy.
 */
export const SURFACE_ENFORCEMENT_MODES = ['off', 'allowlist', 'on'] as const;
export type SurfaceEnforcementMode = (typeof SURFACE_ENFORCEMENT_MODES)[number];

export interface SurfaceEnforcementConfig {
  readonly mode: SurfaceEnforcementMode;
  /** Academy ids the refusal applies to while `mode` is `allowlist`. Ignored in the other modes. */
  readonly academyIds: readonly string[];
}

/**
 * One rollout flag, in the shape `SurfaceEnforcementConfig` already
 * proved: `on` everywhere, `off` nowhere, `allowlist` for the named
 * academies only. See `FeatureFlagsService` for why each flag defaults
 * where it does.
 */
export interface FeatureFlagConfig {
  readonly mode: SurfaceEnforcementMode;
  readonly academyIds: readonly string[];
}

/** P64 Phase 2 (§S) — the five per-academy flags the phase rolls out behind. */
export interface LearningFeatureFlags {
  readonly contentProtected: FeatureFlagConfig;
  /**
   * P64 Phase 2 (D10) — one flag PER TIER, not one for "video".
   *
   * The two tiers roll out on different schedules by decision: the Normal
   * tier depends on nothing new and can canary immediately, while Premium
   * waits for Cloudflare Stream onboarding (DL-19, Phase 2 §T). A single
   * flag would force them to move together and would make the canary
   * meaningless.
   */
  readonly videoNormal: FeatureFlagConfig;
  readonly videoPremium: FeatureFlagConfig;
  /** P64 Phase 3 (§S) — engine v2 and the integrity layer. */
  readonly quizEngineV2: FeatureFlagConfig;
  readonly quizIntegrity: FeatureFlagConfig;
  // `devicesPolicy`, `learnerDashboardV2`, `playerV2` and `certificates`
  // were removed (cloud remediation): nothing ever read them — the device
  // policy became a per-academy setting, the v2 learner surfaces shipped
  // ungated, and certificate eligibility is hardcoded on — so they only
  // documented controls that did not exist. Stale `FLAG_*` values for them
  // in an environment are ignored (the env schema is not strict).
}

/** P64 Phase 3 (§D.6) — certificate delivery settings. */
export interface CertificatesConfig {
  /** Signed download link lifetime; a distinct purpose from content presigns. */
  readonly linkTtlSeconds: number;
}

/**
 * P64 Phase 2 — the PROTECTED object tier (master plan Phase 2 §D.1).
 *
 * A second bucket, not a prefix in the first one. The public bucket is
 * reachable by URL by design — that is what `publicUrlBase` is — so a
 * prefix inside it would be protected only by nobody having guessed the
 * key yet, which is precisely the property S1 says is not a security
 * control. This bucket deliberately has NO public base URL: every read
 * goes through a presigned URL Atlas mints per request.
 *
 * `bucket` falls back to `<public bucket>-protected` so a developer who
 * sets nothing still gets a genuinely separate bucket rather than
 * silently writing protected objects into the public one.
 */
export interface ProtectedMediaConfig {
  readonly bucket: string;
  /**
   * Credentials for the protected bucket.
   *
   * Resolved here rather than at the call site so there is exactly one
   * place that knows about the fallback. When `R2_PROTECTED_ACCESS_KEY_ID`
   * and its secret are set these hold that dedicated, single-bucket
   * token; otherwise they hold the public media credentials, which is
   * what every environment used before the pair existed.
   */
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Presigned-URL lifetime. 10 minutes (Phase 2 §I) — long enough to start a download, short enough that a forwarded link is dead on arrival. */
  readonly signedUrlTtlSeconds: number;
  /** Per-file ceiling for protected uploads — video is uploaded direct-to-provider, so this governs documents and lesson images. */
  readonly maxUploadBytes: number;
}

/** Which `VideoProvider` implementation is wired in. `fake` is the local/test adapter; it signs nothing real and reports no DRM. */
export const VIDEO_PROVIDER_KEYS = ['fake', 'cloudflare_stream', 'r2_worker'] as const;
export type VideoProviderKey = (typeof VIDEO_PROVIDER_KEYS)[number];

/**
 * P64 Phase 2 — provider-hosted video (master plan Phase 2 §D.4, AD-1).
 *
 * Every credential is OPTIONAL and the provider defaults to `fake`,
 * because no real Cloudflare Stream account exists in any Atlas
 * environment yet and the platform must boot without one — the same
 * honest starting state `ZoomConfig` already documents for Live Sessions.
 * `CloudflareStreamProvider` refuses to sign anything when its own
 * credentials are missing rather than pretending to.
 *
 * `customerSubdomain` is the `customer-<hash>.cloudflarestream.com` host
 * the player fetches manifests from; the academy CSP allows exactly that
 * host and nothing else (Phase 2 §I).
 *
 * NOTE, deliberately: there is no price, no currency and no billing field
 * anywhere in this interface. Atlas owns plan quota, usage, enforcement
 * and upgrade messaging; the provider owns its own charges (D5).
 */
/**
 * P64 Phase 2 (DL-19) — the NORMAL tier's delivery gate.
 *
 * Bytes live in the protected R2 bucket Atlas already owns; delivery goes
 * through the Cloudflare CDN on an Atlas-controlled hostname, behind a
 * Worker that validates a token Atlas mints. The Worker is what gives the
 * Normal tier the two properties a bare presign cannot have — per-request
 * authorization and revocation before expiry (AD-16).
 *
 * Every field is optional and the tier reports itself unconfigured
 * without them, for the same reason the Cloudflare block does: the
 * platform must boot in an environment that has neither.
 */
export interface BasicVideoConfig {
  /** The Atlas-owned hostname the Worker is routed on, e.g. `video.atlas.example`. */
  readonly deliveryHost?: string;
  /** Shared secret the Worker verifies Atlas's token with. Never leaves the server. */
  readonly signingSecret?: string;
  /**
   * Credential lifetime for a Normal-tier playback URL.
   *
   * Short by design (10 minutes): it is the only thing enforcing
   * revocation latency, and the player refreshes rather than holding a
   * long-lived credential. Raising it would trade the Normal tier's one
   * genuine advantage over Premium for nothing.
   */
  readonly playbackTtlSeconds: number;
  /**
   * Where Atlas publishes a revoked session so the gate stops honouring
   * its tokens before they expire.
   *
   * Optional, and its absence is REPORTED rather than hidden: without it
   * `BasicVideoProvider` reports `revocableBeforeExpiry: false`, because
   * a revocation list nobody writes to revokes nothing (AD-16).
   */
  readonly revocationEndpoint?: string;
  readonly revocationToken?: string;
  /**
   * Whether an origin allowlist has actually been pushed to the gate.
   *
   * Same reasoning: `originRestricted` must describe what is enforced,
   * not what the gate is capable of enforcing.
   */
  readonly allowedOriginsConfigured: boolean;
}

export interface VideoProviderConfig {
  /**
   * The adapter bound for the PREMIUM tier, and the default when no tier
   * resolution applies. The Normal tier's adapter is selected by tier, not
   * by this field — see `VideoProviderRegistry`.
   */
  readonly provider: VideoProviderKey;
  readonly accountId?: string;
  readonly apiToken?: string;
  /** The Stream signing key id and its PEM/JWK, used to mint playback tokens LOCALLY — never a round-trip to the provider per play. */
  readonly signingKeyId?: string;
  readonly signingKeyPem?: string;
  readonly webhookSecret?: string;
  readonly customerSubdomain?: string;
  /** Playback-token lifetime. 2 hours (Phase 2 §I), bound to session and device. */
  readonly playbackTokenTtlSeconds: number;
}

/**
 * P64 Phase 2 — the learning LEASE (AD-10, D4).
 *
 * One learner, one active learning session at a time by default. The lease
 * is a short-TTL Redis key refreshed by heartbeats, so a browser that
 * crashes releases it by expiring rather than by being cleaned up — there
 * is no reliable "goodbye" from a closing tab, and a lease that needed one
 * would strand learners out of their own account.
 */
export interface LearningLeaseConfig {
  /** Lease TTL. 60 s (Phase 2 §D.7). */
  readonly ttlSeconds: number;
  /** How often the client is told to heartbeat. 20 s — a third of the TTL, so two consecutive losses are tolerated. */
  readonly heartbeatSeconds: number;
}

export interface CloudflareConfig {
  readonly apiToken?: string;
  readonly zoneId?: string;
  readonly accountId?: string;
}

/** Phase P12 — Atlas Subscription Billing configuration (master plan §5.7, §16). */
/**
 * Atlas's OWN Zoom application configuration.
 *
 * Every field is optional because no real Zoom app exists in any Atlas
 * environment yet, and the platform must run without one. `isOAuthReady`
 * is the single predicate the rest of the code asks — no caller
 * re-derives "do we have enough to start an authorization?" from the
 * individual fields.
 */
export interface ZoomConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly redirectUri?: string;
  readonly webhookSecretToken?: string;
  readonly sdkKey?: string;
  readonly sdkSecret?: string;
}

export interface BillingConfig {
  readonly webhookSecret: string;
}

/**
 * Organization Payment Configuration (master plan §5.8, §16; product
 * decisions §4.1/§4.2, 2026-08-26). `credentialEncryptionKeyHex` is the raw
 * hex string as read from the environment — `CredentialEncryptionService`
 * is the one place it is ever turned into a `Buffer` for actual AES-256-GCM
 * use, matching this codebase's "one seam, never ad hoc" convention
 * (`toMinorUnits`/`buildPaymentProofStorageKey`'s identical precedent).
 */
export interface PaymentConfigurationConfig {
  readonly credentialEncryptionKeyHex: string;
}

/** Phase P17 — Notifications, Email & Search configuration (master plan §12, §21). */
export type EmailProviderName = EnvVariables['EMAIL_PROVIDER'];

/** P17 + P64 Communications — see `env.validation.ts` for each variable's semantics. */
export interface EmailConfig {
  /** Legacy single-provider alias; `providers` is what the registry reads. */
  readonly provider: EmailProviderName;
  /** Ordered fallback chain (`EMAIL_PROVIDERS`, default `[provider]`). */
  readonly providers: readonly EmailProviderName[];
  /** Legacy `EMAIL_API_KEY` (Resend). */
  readonly apiKey?: string;
  readonly resendApiKey?: string;
  readonly brevoApiKey?: string;
  readonly fromEmail?: string;
  readonly fromName: string;
  readonly replyTo?: string;
  readonly brevoWebhookSecret?: string;
  readonly resendWebhookSecret?: string;
}

/** P64 Communications — link building and platform branding for outbound email. */
export interface CommunicationsConfig {
  /** Public origin of the platform web app (`PLATFORM_WEB_URL`), no trailing slash. */
  readonly platformWebUrl: string;
  /** The platform's display name in email branding; reuses `EMAIL_FROM_NAME`. */
  readonly platformName: string;
  /**
   * P64 C5 — whether the tenant lifecycle sequences (§26 T1–T6, §27
   * S1–S10) evaluate and send. `off` by default; `dry_run` records what
   * it would have sent. See `FLAG_LIFECYCLE_SEQUENCES_MODE`.
   */
  readonly lifecycleSequencesMode: LifecycleSequencesMode;
  /**
   * P64 C6 — whether the hosted-video retention sequence (§31/§32)
   * evaluates, warns and deletes. `off` by default; `warn_only` sends the
   * full W1-W4 warning sequence and deletes nothing. See
   * `FLAG_VIDEO_RETENTION_MODE`.
   */
  readonly videoRetentionMode: VideoRetentionMode;
}

/** P64 C5 — the staged rollout of the lifecycle sequences (§43). */
export type LifecycleSequencesMode = 'off' | 'dry_run' | 'on';

/**
 * P64 C6 — the staged rollout of hosted-video retention (§43).
 *
 * `warn_only` is the middle setting rather than a `dry_run`, and the
 * difference is deliberate: the observable half of this feature IS the
 * warning sequence, and the half that must be held back is the
 * irreversible one. There is no mode that deletes without warning.
 */
export type VideoRetentionMode = 'off' | 'warn_only' | 'on';

/** Phase P1 — Identity, Auth & Sessions configuration (master plan §8). */
export interface IdentityConfig {
  readonly jwtAccessSecret: string;
  readonly jwtAccessTtlSeconds: number;
  readonly refreshTokenTtlDays: number;
  readonly passwordResetTokenTtlMinutes: number;
  /** Phase 10.1 — verification-link lifetime. Longer than a password reset: a signup email is often opened hours later, and the token is single-use and low-value on its own. */
  readonly emailVerificationTokenTtlMinutes: number;
  /**
   * Phase 10.1 — whether registration performs the DNS deliverability
   * lookup. The disposable-domain list is unaffected and always applies.
   *
   * Off in `test` by default: the suite registers accounts at
   * `@atlas.test`, a reserved TLD (RFC 2606) that by definition has no
   * DNS, and making tests depend on live DNS would make them slow, flaky
   * and broken on an offline CI runner. On everywhere else.
   */
  readonly emailDeliverabilityCheckEnabled: boolean;
  readonly signInRateLimit: { readonly max: number; readonly windowSeconds: number };
  readonly passwordResetRateLimit: {
    readonly max: number;
    readonly windowSeconds: number;
  };
  /** Phase P18 — see `env.validation.ts`'s own doc comment on `AUTH_REGISTER_RATE_LIMIT_MAX`. */
  readonly registerRateLimit: { readonly max: number; readonly windowSeconds: number };
  /** P64 Communications C4 (§12) — email one-time codes and trusted devices. */
  readonly emailOtp: EmailOtpConfig;
}

/**
 * P64 Communications C4 (§12) — when sign-in demands an emailed code.
 *
 *  - `off`        — never; sign-in behaves exactly as it did before C4.
 *  - `new_device` — only when this browser presents no live `atlas_trust`
 *                   cookie for this user AND this surface (the §12 model).
 *  - `always`     — every sign-in, trusted browser or not.
 *
 * This is a ROLLOUT switch, never a security boundary: it decides whether
 * an ADDITIONAL factor is demanded on top of the password, and no value of
 * it can weaken or bypass a control that already exists. Everything the
 * challenge itself enforces — hashing, expiry, attempt ceiling, single
 * use, device binding — is unconditional.
 *
 * Both surfaces default to `off`, matching the staged rollout §50 sets out
 * (`off` -> management -> academies). An unset variable must never be the
 * reason production starts mailing codes on every sign-in.
 */
export type EmailOtpPolicy = 'off' | 'new_device' | 'always';

export interface EmailOtpConfig {
  readonly management: EmailOtpPolicy;
  readonly academy: EmailOtpPolicy;
  /** §12: 10 minutes. */
  readonly codeTtlSeconds: number;
  /** §12: 5 verify attempts, then the challenge is destroyed. */
  readonly maxAttempts: number;
  /** §12: at most 3 codes per challenge — the first plus two resends. */
  readonly maxCodesPerChallenge: number;
  /** §12: 60 seconds between codes. */
  readonly resendCooldownSeconds: number;
  /** §12: 5 challenges per account per hour. */
  readonly challengesPerHour: number;
  /** §12: trust lasts 90 days for staff... */
  readonly trustedDeviceDaysManagement: number;
  /** ...and 180 days for learners, who sign in far less often. */
  readonly trustedDeviceDaysAcademy: number;
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

  const observability: ObservabilityConfig = {
    // An empty string is normalised to `undefined` so a deployment can
    // disable reporting by blanking the variable, without having to
    // remove it from its environment file.
    sentryDsn: env.SENTRY_DSN ? env.SENTRY_DSN : undefined,
    sentryTracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    sentryEnvironment: env.SENTRY_ENVIRONMENT ?? nodeEnv,
  };

  const identity: IdentityConfig = {
    jwtAccessSecret: env.JWT_ACCESS_SECRET,
    jwtAccessTtlSeconds: Number(env.JWT_ACCESS_TTL_SECONDS ?? 900),
    refreshTokenTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS ?? 30),
    passwordResetTokenTtlMinutes: Number(env.PASSWORD_RESET_TOKEN_TTL_MINUTES ?? 45),
    emailVerificationTokenTtlMinutes: Number(
      env.EMAIL_VERIFICATION_TOKEN_TTL_MINUTES ?? 1440,
    ),
    emailDeliverabilityCheckEnabled:
      env.EMAIL_DELIVERABILITY_CHECK_ENABLED ?? nodeEnv !== 'test',
    signInRateLimit: {
      max: Number(env.AUTH_SIGNIN_RATE_LIMIT_MAX ?? 10),
      windowSeconds: Number(env.AUTH_SIGNIN_RATE_LIMIT_WINDOW_SECONDS ?? 900),
    },
    passwordResetRateLimit: {
      max: Number(env.AUTH_PASSWORD_RESET_RATE_LIMIT_MAX ?? 5),
      windowSeconds: Number(env.AUTH_PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS ?? 3600),
    },
    registerRateLimit: {
      max: Number(env.AUTH_REGISTER_RATE_LIMIT_MAX ?? 5),
      windowSeconds: Number(env.AUTH_REGISTER_RATE_LIMIT_WINDOW_SECONDS ?? 3600),
    },
    emailOtp: {
      // Defaults to `off` on BOTH surfaces — see `EmailOtpConfig`.
      management: (env.FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT ?? 'off') as EmailOtpPolicy,
      academy: (env.FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY ?? 'off') as EmailOtpPolicy,
      codeTtlSeconds: Number(env.AUTH_EMAIL_OTP_CODE_TTL_SECONDS ?? 600),
      maxAttempts: Number(env.AUTH_EMAIL_OTP_MAX_ATTEMPTS ?? 5),
      maxCodesPerChallenge: Number(env.AUTH_EMAIL_OTP_MAX_CODES ?? 3),
      resendCooldownSeconds: Number(env.AUTH_EMAIL_OTP_RESEND_COOLDOWN_SECONDS ?? 60),
      challengesPerHour: Number(env.AUTH_EMAIL_OTP_CHALLENGES_PER_HOUR ?? 5),
      trustedDeviceDaysManagement: Number(env.AUTH_TRUSTED_DEVICE_DAYS_MANAGEMENT ?? 90),
      trustedDeviceDaysAcademy: Number(env.AUTH_TRUSTED_DEVICE_DAYS_ACADEMY ?? 180),
    },
  };

  const media: MediaStorageConfig = {
    endpoint: env.R2_ENDPOINT,
    region: env.R2_REGION,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicUrlBase: env.R2_PUBLIC_URL_BASE,
    // `env` here is `process.env` under an unsafe cast (this factory's own
    // established pattern, see its header comment) — `validateEnv`'s zod
    // `.transform()` only affects the object zod itself returns, which
    // this factory never receives, so the raw string must be coerced here
    // too, matching `Number(env.PORT ?? ...)`'s identical precedent for
    // numeric fields.
    forcePathStyle: (env.R2_FORCE_PATH_STYLE as unknown as string) !== 'false',
    maxUploadBytes: Number(env.MEDIA_MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
  };

  const platformDomain: PlatformDomainRuntimeConfig = {
    baseDomain: env.PLATFORM_BASE_DOMAIN || undefined,
  };

  const zoom: ZoomConfig = {
    clientId: env.ZOOM_OAUTH_CLIENT_ID || undefined,
    clientSecret: env.ZOOM_OAUTH_CLIENT_SECRET || undefined,
    redirectUri: env.ZOOM_OAUTH_REDIRECT_URI || undefined,
    webhookSecretToken: env.ZOOM_WEBHOOK_SECRET_TOKEN || undefined,
    sdkKey: env.ZOOM_SDK_KEY || undefined,
    sdkSecret: env.ZOOM_SDK_SECRET || undefined,
  };

  const surfaceEnforcement: SurfaceEnforcementConfig = {
    // Defaults to full enforcement: an unset variable must never be the
    // reason a learner reaches the management surface.
    mode: (env.SURFACE_ENFORCE_MODE ?? 'on') as SurfaceEnforcementMode,
    academyIds: (env.SURFACE_ENFORCE_ACADEMY_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  };

  const readFlag = (
    modeVar: string | undefined,
    idsVar: string | undefined,
  ): FeatureFlagConfig => ({
    // Defaults to `off` — see `FeatureFlagsService`. An unset variable must
    // never be the reason a rollout reaches an academy that has not been
    // canaried.
    mode: (modeVar ?? 'off') as SurfaceEnforcementMode,
    academyIds: (idsVar ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  });

  const learningFeatureFlags: LearningFeatureFlags = {
    contentProtected: readFlag(
      env.FLAG_CONTENT_PROTECTED_MODE,
      env.FLAG_CONTENT_PROTECTED_ACADEMY_IDS,
    ),
    videoNormal: readFlag(env.FLAG_VIDEO_NORMAL_MODE, env.FLAG_VIDEO_NORMAL_ACADEMY_IDS),
    videoPremium: readFlag(
      env.FLAG_VIDEO_PREMIUM_MODE,
      env.FLAG_VIDEO_PREMIUM_ACADEMY_IDS,
    ),
    quizEngineV2: readFlag(
      env.FLAG_QUIZ_ENGINE_V2_MODE,
      env.FLAG_QUIZ_ENGINE_V2_ACADEMY_IDS,
    ),
    quizIntegrity: readFlag(
      env.FLAG_QUIZ_INTEGRITY_MODE,
      env.FLAG_QUIZ_INTEGRITY_ACADEMY_IDS,
    ),
  };

  const certificates: CertificatesConfig = {
    linkTtlSeconds: Number(env.CERTIFICATE_LINK_TTL_SECONDS ?? 3600),
  };

  const protectedMedia: ProtectedMediaConfig = {
    bucket: env.R2_PROTECTED_BUCKET || `${env.R2_BUCKET}-protected`,
    // `env.validation.ts` rejects a half-configured pair, so testing one
    // of the two is enough to know both are present.
    accessKeyId: env.R2_PROTECTED_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_PROTECTED_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY,
    signedUrlTtlSeconds: Number(env.PROTECTED_MEDIA_URL_TTL_SECONDS ?? 600),
    maxUploadBytes: Number(env.PROTECTED_MEDIA_MAX_UPLOAD_BYTES ?? 50 * 1024 * 1024),
  };

  const basicVideo: BasicVideoConfig = {
    deliveryHost: env.BASIC_VIDEO_DELIVERY_HOST || undefined,
    signingSecret: env.BASIC_VIDEO_SIGNING_SECRET || undefined,
    playbackTtlSeconds: Number(env.BASIC_VIDEO_PLAYBACK_TTL_SECONDS ?? 600),
    revocationEndpoint: env.BASIC_VIDEO_REVOCATION_ENDPOINT || undefined,
    revocationToken: env.BASIC_VIDEO_REVOCATION_TOKEN || undefined,
    allowedOriginsConfigured:
      (env.BASIC_VIDEO_ALLOWED_ORIGINS_CONFIGURED ?? 'false') === 'true',
  };

  const video: VideoProviderConfig = {
    provider: (env.VIDEO_PROVIDER ?? 'fake') as VideoProviderKey,
    accountId: env.CLOUDFLARE_STREAM_ACCOUNT_ID || undefined,
    apiToken: env.CLOUDFLARE_STREAM_API_TOKEN || undefined,
    signingKeyId: env.CLOUDFLARE_STREAM_SIGNING_KEY_ID || undefined,
    signingKeyPem: env.CLOUDFLARE_STREAM_SIGNING_KEY_PEM || undefined,
    webhookSecret: env.CLOUDFLARE_STREAM_WEBHOOK_SECRET || undefined,
    customerSubdomain: env.CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN || undefined,
    playbackTokenTtlSeconds: Number(env.VIDEO_PLAYBACK_TOKEN_TTL_SECONDS ?? 2 * 60 * 60),
  };

  const learningLease: LearningLeaseConfig = {
    ttlSeconds: Number(env.LEARNING_LEASE_TTL_SECONDS ?? 60),
    heartbeatSeconds: Number(env.LEARNING_LEASE_HEARTBEAT_SECONDS ?? 20),
  };

  const cloudflare: CloudflareConfig = {
    apiToken: env.CLOUDFLARE_API_TOKEN || undefined,
    zoneId: env.CLOUDFLARE_ZONE_ID || undefined,
    accountId: env.CLOUDFLARE_ACCOUNT_ID || undefined,
  };

  const billing: BillingConfig = {
    webhookSecret: env.PAYMENT_WEBHOOK_SECRET,
  };

  const paymentConfiguration: PaymentConfigurationConfig = {
    credentialEncryptionKeyHex: env.PAYMENT_CREDENTIALS_ENCRYPTION_KEY,
  };

  const emailProvider: EmailProviderName = env.EMAIL_PROVIDER ?? 'stub';
  // `env` is raw `process.env` here (see this factory's header comment),
  // so `EMAIL_PROVIDERS` is the untransformed comma string — parsed again
  // exactly as `validateEnv` did; entries are already validated there.
  const rawEmailProviders = (env as unknown as { EMAIL_PROVIDERS?: string })
    .EMAIL_PROVIDERS;
  const emailProviders = (
    typeof rawEmailProviders === 'string' && rawEmailProviders.trim()
      ? rawEmailProviders
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean)
      : [emailProvider]
  ) as EmailProviderName[];
  const email: EmailConfig = {
    provider: emailProvider,
    providers: emailProviders,
    apiKey: env.EMAIL_API_KEY || undefined,
    resendApiKey: env.RESEND_API_KEY || undefined,
    brevoApiKey: env.BREVO_API_KEY || undefined,
    fromEmail: env.EMAIL_FROM_EMAIL || undefined,
    fromName: env.EMAIL_FROM_NAME ?? 'Atlas',
    replyTo: env.EMAIL_REPLY_TO || undefined,
    brevoWebhookSecret: env.BREVO_WEBHOOK_SECRET || undefined,
    resendWebhookSecret: env.RESEND_WEBHOOK_SECRET || undefined,
  };

  const communications: CommunicationsConfig = {
    platformWebUrl: (env.PLATFORM_WEB_URL || 'http://localhost:3001').replace(/\/+$/, ''),
    platformName: env.EMAIL_FROM_NAME ?? 'Atlas',
    // Defaults to `off` — see `FLAG_LIFECYCLE_SEQUENCES_MODE`.
    lifecycleSequencesMode: (env.FLAG_LIFECYCLE_SEQUENCES_MODE ??
      'off') as LifecycleSequencesMode,
    // Defaults to `off` — see `FLAG_VIDEO_RETENTION_MODE`. This one
    // deletes customer data when it is `on`.
    videoRetentionMode: (env.FLAG_VIDEO_RETENTION_MODE ?? 'off') as VideoRetentionMode,
  };

  return {
    app,
    communications,
    database,
    redis,
    observability,
    identity,
    media,
    learningFeatureFlags,
    certificates,
    protectedMedia,
    video,
    basicVideo,
    learningLease,
    platformDomain,
    surfaceEnforcement,
    cloudflare,
    zoom,
    billing,
    paymentConfiguration,
    email,
  };
};
