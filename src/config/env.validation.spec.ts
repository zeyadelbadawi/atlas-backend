import { validateEnv } from './env.validation';

const VALID_BASE = {
  DATABASE_URL: 'postgresql://atlas:pw@localhost:5432/atlas_dev',
  REDIS_URL: 'redis://localhost:6379',
  // Phase P1 — required, no default (see this file's own header comment
  // and env.validation.ts's JWT_ACCESS_SECRET definition).
  JWT_ACCESS_SECRET: 'unit-test-secret-at-least-32-characters-long',
  // Phase P2 — required, no default (RLS is inert against DATABASE_URL's
  // superuser connection; see env.validation.ts's APP_DATABASE_URL definition).
  APP_DATABASE_URL: 'postgresql://atlas_app:pw@localhost:5432/atlas_dev',
  // Phase P8 — required, no default (see env.validation.ts's R2_* definitions).
  R2_ENDPOINT: 'http://localhost:9000',
  R2_ACCESS_KEY_ID: 'unit-test-access-key',
  R2_SECRET_ACCESS_KEY: 'unit-test-secret-key',
  R2_BUCKET: 'atlas-media-test',
  R2_PUBLIC_URL_BASE: 'http://localhost:9000/atlas-media-test',
  // Phase P12 — required, no default (see env.validation.ts's
  // PAYMENT_WEBHOOK_SECRET definition — same "Atlas controls both ends of
  // this contract" reasoning as JWT_ACCESS_SECRET above).
  PAYMENT_WEBHOOK_SECRET: 'unit-test-webhook-secret-at-least-32-chars',
  // Organization Payment Configuration foundation — required, no default
  // (see env.validation.ts's PAYMENT_CREDENTIALS_ENCRYPTION_KEY
  // definition). Exactly 64 hex characters (32 raw bytes).
  PAYMENT_CREDENTIALS_ENCRYPTION_KEY:
    'fdd0676972987fc315cf21cfbc8b1e030a082597f61fcd9073174ddb92b472b1',
};

describe('validateEnv', () => {
  it('accepts a minimal valid development configuration', () => {
    const result = validateEnv({ ...VALID_BASE, NODE_ENV: 'development' });
    expect(result.NODE_ENV).toBe('development');
    expect(result.PORT).toBe(3000);
    expect(result.LOG_LEVEL).toBe('info');
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => validateEnv({ REDIS_URL: VALID_BASE.REDIS_URL })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('throws when REDIS_URL is missing', () => {
    expect(() => validateEnv({ DATABASE_URL: VALID_BASE.DATABASE_URL })).toThrow(
      /REDIS_URL/,
    );
  });

  it('rejects a DATABASE_URL that is not a postgresql:// connection string', () => {
    expect(() =>
      validateEnv({ ...VALID_BASE, DATABASE_URL: 'mysql://localhost/atlas' }),
    ).toThrow(/postgresql:\/\//);
  });

  it('rejects a REDIS_URL that is not a redis:// connection string', () => {
    expect(() =>
      validateEnv({ ...VALID_BASE, REDIS_URL: 'http://localhost:6379' }),
    ).toThrow(/redis:\/\//);
  });

  it('requires CORS_ALLOWED_ORIGINS when NODE_ENV=production', () => {
    expect(() => validateEnv({ ...VALID_BASE, NODE_ENV: 'production' })).toThrow(
      /CORS_ALLOWED_ORIGINS is required/,
    );
  });

  it('accepts production configuration once CORS_ALLOWED_ORIGINS is set', () => {
    const result = validateEnv({
      ...VALID_BASE,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.atlas-platform.com',
    });
    expect(result.NODE_ENV).toBe('production');
  });

  it('coerces PORT to a number', () => {
    const result = validateEnv({ ...VALID_BASE, PORT: '4000' });
    expect(result.PORT).toBe(4000);
  });

  it('rejects an unrecognized LOG_LEVEL rather than silently accepting it', () => {
    expect(() => validateEnv({ ...VALID_BASE, LOG_LEVEL: 'verbose' })).toThrow();
  });

  it('throws when JWT_ACCESS_SECRET is missing', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: VALID_BASE.DATABASE_URL,
        REDIS_URL: VALID_BASE.REDIS_URL,
      }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });

  it('rejects a JWT_ACCESS_SECRET shorter than 32 characters', () => {
    expect(() => validateEnv({ ...VALID_BASE, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      /JWT_ACCESS_SECRET/,
    );
  });

  it('throws when APP_DATABASE_URL is missing', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: VALID_BASE.DATABASE_URL,
        REDIS_URL: VALID_BASE.REDIS_URL,
        JWT_ACCESS_SECRET: VALID_BASE.JWT_ACCESS_SECRET,
      }),
    ).toThrow(/APP_DATABASE_URL/);
  });

  it('rejects an APP_DATABASE_URL that is not a postgresql:// connection string', () => {
    expect(() =>
      validateEnv({ ...VALID_BASE, APP_DATABASE_URL: 'mysql://localhost/atlas' }),
    ).toThrow(/APP_DATABASE_URL/);
  });

  it('throws when R2_BUCKET is missing', () => {
    const withoutBucket: Record<string, string> = { ...VALID_BASE };
    delete withoutBucket.R2_BUCKET;
    expect(() => validateEnv(withoutBucket)).toThrow(/R2_BUCKET/);
  });

  it('defaults R2_FORCE_PATH_STYLE to true and MEDIA_MAX_UPLOAD_BYTES to 10MB', () => {
    const result = validateEnv(VALID_BASE);
    expect(result.R2_FORCE_PATH_STYLE).toBe(true);
    expect(result.MEDIA_MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });
});
