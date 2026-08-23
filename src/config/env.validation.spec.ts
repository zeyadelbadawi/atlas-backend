import { validateEnv } from './env.validation';

const VALID_BASE = {
  DATABASE_URL: 'postgresql://atlas:pw@localhost:5432/atlas_dev',
  REDIS_URL: 'redis://localhost:6379',
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
});
