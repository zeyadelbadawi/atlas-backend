/**
 * The boot contract for email configuration.
 *
 * Production has never had `EMAIL_*` set (the deploy workflow injects no
 * email secret; the host env is the only place it could live), so the
 * communications work must be deployable BEFORE the owner creates any
 * provider account. These cases pin the three outcomes that matter:
 *
 *   1. no email configuration at all  -> boots, on the stub (nothing sent)
 *   2. a real provider listed with no key -> REFUSES to start, rather than
 *      booting and silently dropping every security email
 *   3. the intended production shape  -> accepted
 *
 * Case 2 is the safety property: a half-configured provider is worse than
 * none, because password resets and OTP codes would be accepted by the
 * app and never delivered.
 */
import { validateEnv } from '../src/config/env.validation';

/** A production environment with every unrelated requirement satisfied. */
const PRODUCTION_BASE: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/atlas',
  APP_DATABASE_URL: 'postgresql://app:pass@localhost:5432/atlas',
  JWT_SECRET: 'j'.repeat(40),
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  REDIS_URL: 'redis://localhost:6379',
  PLATFORM_BASE_DOMAIN: 'atlass.dpdns.org',
  R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'atlas-media',
  R2_PUBLIC_URL_BASE: 'https://cdn.example',
  PAYMENT_WEBHOOK_SECRET: 'w'.repeat(32),
  PAYMENT_CREDENTIALS_ENCRYPTION_KEY: 'ab'.repeat(32),
  CORS_ALLOWED_ORIGINS: 'https://atlass.dpdns.org',
};

describe('P64 Communications — email configuration boot contract', () => {
  it('boots with no email configuration at all, on the stub provider', () => {
    const config = validateEnv({ ...PRODUCTION_BASE }) as Record<string, unknown>;
    expect(config.EMAIL_PROVIDER).toBe('stub');
    expect(config.EMAIL_PROVIDERS ?? undefined).toBeUndefined();
  });

  it('refuses to start when a real provider is listed without its API key', () => {
    // Both providers listed, neither configured: whichever is reported
    // first, the boot must fail rather than accept security email it
    // cannot deliver.
    expect(() =>
      validateEnv({ ...PRODUCTION_BASE, EMAIL_PROVIDERS: 'brevo,resend' }),
    ).toThrow(/API_KEY/i);
  });

  it('names Brevo specifically when Brevo alone is listed without a key', () => {
    expect(() => validateEnv({ ...PRODUCTION_BASE, EMAIL_PROVIDERS: 'brevo' })).toThrow(
      /BREVO_API_KEY/i,
    );
  });

  it('refuses to start when a real provider is listed without a From address', () => {
    expect(() =>
      validateEnv({
        ...PRODUCTION_BASE,
        EMAIL_PROVIDERS: 'brevo',
        BREVO_API_KEY: 'brevo-key',
      }),
    ).toThrow(/EMAIL_FROM_EMAIL/i);
  });

  it('accepts the intended production shape: Brevo primary, Resend fallback', () => {
    const config = validateEnv({
      ...PRODUCTION_BASE,
      EMAIL_PROVIDERS: 'brevo,resend',
      BREVO_API_KEY: 'brevo-key',
      RESEND_API_KEY: 'resend-key',
      EMAIL_FROM_EMAIL: 'owner@example.com',
      EMAIL_FROM_NAME: 'Atlas',
    }) as Record<string, unknown>;
    expect(config.EMAIL_PROVIDERS).toEqual(['brevo', 'resend']);
  });

  it('still accepts the legacy single-provider alias, so existing envs keep working', () => {
    const config = validateEnv({
      ...PRODUCTION_BASE,
      EMAIL_PROVIDER: 'resend',
      EMAIL_API_KEY: 'legacy-resend-key',
      EMAIL_FROM_EMAIL: 'owner@example.com',
    }) as Record<string, unknown>;
    expect(config.EMAIL_PROVIDER).toBe('resend');
  });
});
