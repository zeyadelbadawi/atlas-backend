/**
 * B0-MED-11 — turning the Normal video tier on is configuration only, so a
 * half-made configuration must fail the deploy rather than every upload.
 *
 * In production, `FLAG_VIDEO_NORMAL_MODE` other than `off` needs the
 * delivery gate (`BASIC_VIDEO_DELIVERY_HOST` + `BASIC_VIDEO_SIGNING_SECRET`);
 * without them the registry reports the tier unavailable and every upload
 * is refused `videoNotEnabled`. With the flag `off` — today's production
 * state — nothing is required, and outside production the local stand-in
 * serves the tier, so nothing is required either.
 *
 * All values are obvious placeholders.
 */
import { validateEnv } from './env.validation';

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://atlas:pw@localhost:5432/atlas_dev',
  APP_DATABASE_URL: 'postgresql://atlas_app:pw@localhost:5432/atlas_dev',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'unit-test-secret-at-least-32-characters-long',
  PAYMENT_WEBHOOK_SECRET: 'unit-test-webhook-secret-at-least-32-chars',
  PAYMENT_CREDENTIALS_ENCRYPTION_KEY:
    'fdd0676972987fc315cf21cfbc8b1e030a082597f61fcd9073174ddb92b472b1',
  R2_ENDPOINT: 'http://localhost:9000',
  R2_ACCESS_KEY_ID: 'k',
  R2_SECRET_ACCESS_KEY: 's',
  R2_BUCKET: 'atlas-media-test',
  R2_PUBLIC_URL_BASE: 'http://localhost:9000/atlas-media-test',
  PLATFORM_BASE_DOMAIN: 'atlas.example.test',
  CORS_ALLOWED_ORIGINS: 'https://atlas.example.test',
};

const PRODUCTION = { ...BASE_ENV, NODE_ENV: 'production' };
const GATE = {
  BASIC_VIDEO_DELIVERY_HOST: 'video.atlas.example.test',
  BASIC_VIDEO_SIGNING_SECRET: 'unit-test-gate-signing-secret',
};

describe('Normal video tier activation config (B0-MED-11)', () => {
  it('requires nothing while the flag is off, in production or not', () => {
    expect(() => validateEnv(PRODUCTION)).not.toThrow();
    expect(() =>
      validateEnv({ ...PRODUCTION, FLAG_VIDEO_NORMAL_MODE: 'off' }),
    ).not.toThrow();
  });

  it.each(['allowlist', 'on'])(
    'refuses to start in production with FLAG_VIDEO_NORMAL_MODE=%s and no delivery gate, naming what is missing',
    (mode) => {
      expect(() => validateEnv({ ...PRODUCTION, FLAG_VIDEO_NORMAL_MODE: mode })).toThrow(
        /BASIC_VIDEO_DELIVERY_HOST, BASIC_VIDEO_SIGNING_SECRET/,
      );
      expect(() =>
        validateEnv({
          ...PRODUCTION,
          FLAG_VIDEO_NORMAL_MODE: mode,
          BASIC_VIDEO_DELIVERY_HOST: GATE.BASIC_VIDEO_DELIVERY_HOST,
        }),
      ).toThrow(/requires BASIC_VIDEO_SIGNING_SECRET —/);
    },
  );

  it('never prints a configured value in the refusal', () => {
    try {
      validateEnv({
        ...PRODUCTION,
        FLAG_VIDEO_NORMAL_MODE: 'on',
        BASIC_VIDEO_SIGNING_SECRET: GATE.BASIC_VIDEO_SIGNING_SECRET,
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toContain('BASIC_VIDEO_DELIVERY_HOST');
      expect((error as Error).message).not.toContain(GATE.BASIC_VIDEO_SIGNING_SECRET);
    }
  });

  it('starts in production once the gate is configured', () => {
    expect(() =>
      validateEnv({ ...PRODUCTION, ...GATE, FLAG_VIDEO_NORMAL_MODE: 'allowlist' }),
    ).not.toThrow();
  });

  it('outside production the local stand-in serves the tier, so nothing is required', () => {
    expect(() =>
      validateEnv({ ...BASE_ENV, NODE_ENV: 'development', FLAG_VIDEO_NORMAL_MODE: 'on' }),
    ).not.toThrow();
  });
});
