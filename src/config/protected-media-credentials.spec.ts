/**
 * P64 Phase 2 — the protected bucket's credentials.
 *
 * `ProtectedMediaStorage` writes lesson media that only an entitled
 * learner may read. Giving it its own R2 token, scoped to the protected
 * bucket alone, means a leak of that token cannot reach the public media
 * bucket (avatars, thumbnails, course images) and a leak of the public
 * token cannot reach protected lesson media. Sharing one token across
 * both buckets makes either leak total.
 *
 * The pair is OPTIONAL: every environment that predates it keeps working
 * unchanged by falling back to the public media credentials. These tests
 * pin both halves of that — the dedicated path and the fallback — and
 * that configuring the protected bucket never disturbs the public one.
 *
 * All values here are obvious placeholders. No real credential belongs in
 * a fixture, and a test that needed one would be testing the wrong thing.
 */
import loadConfiguration from './configuration';
import { validateEnv } from './env.validation';
import type { MediaStorageConfig, ProtectedMediaConfig } from './configuration';

const PUBLIC_KEY_ID = 'unit-test-public-key-id';
const PUBLIC_SECRET = 'unit-test-public-secret';
const PROTECTED_KEY_ID = 'unit-test-protected-key-id';
const PROTECTED_SECRET = 'unit-test-protected-secret';

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: 'postgresql://atlas:pw@localhost:5432/atlas_dev',
  APP_DATABASE_URL: 'postgresql://atlas_app:pw@localhost:5432/atlas_dev',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'unit-test-secret-at-least-32-characters-long',
  PAYMENT_WEBHOOK_SECRET: 'unit-test-webhook-secret-at-least-32-chars',
  PAYMENT_CREDENTIALS_ENCRYPTION_KEY:
    'fdd0676972987fc315cf21cfbc8b1e030a082597f61fcd9073174ddb92b472b1',
  R2_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: PUBLIC_KEY_ID,
  R2_SECRET_ACCESS_KEY: PUBLIC_SECRET,
  R2_BUCKET: 'atlas-media-prod',
  R2_PUBLIC_URL_BASE: 'https://media.example.com',
};

/** Loads the configuration under a specific environment, restoring the real one afterwards. */
function loadWith(overrides: Record<string, string | undefined>): {
  media: MediaStorageConfig;
  protectedMedia: ProtectedMediaConfig;
} {
  const saved = process.env;
  try {
    const next: Record<string, string> = { ...BASE_ENV };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    process.env = next as unknown as NodeJS.ProcessEnv;
    const config = loadConfiguration() as unknown as {
      media: MediaStorageConfig;
      protectedMedia: ProtectedMediaConfig;
    };
    return { media: config.media, protectedMedia: config.protectedMedia };
  } finally {
    process.env = saved;
  }
}

describe('protected media credentials (P64 Phase 2)', () => {
  describe('dedicated protected credentials configured', () => {
    it('uses the protected token for the protected bucket', () => {
      const { protectedMedia } = loadWith({
        R2_PROTECTED_BUCKET: 'atlas-media-prod-protected',
        R2_PROTECTED_ACCESS_KEY_ID: PROTECTED_KEY_ID,
        R2_PROTECTED_SECRET_ACCESS_KEY: PROTECTED_SECRET,
      });
      expect(protectedMedia.accessKeyId).toBe(PROTECTED_KEY_ID);
      expect(protectedMedia.secretAccessKey).toBe(PROTECTED_SECRET);
    });

    it('leaves the PUBLIC media credentials untouched — the whole point of the split', () => {
      const { media } = loadWith({
        R2_PROTECTED_BUCKET: 'atlas-media-prod-protected',
        R2_PROTECTED_ACCESS_KEY_ID: PROTECTED_KEY_ID,
        R2_PROTECTED_SECRET_ACCESS_KEY: PROTECTED_SECRET,
      });
      expect(media.accessKeyId).toBe(PUBLIC_KEY_ID);
      expect(media.secretAccessKey).toBe(PUBLIC_SECRET);
      expect(media.bucket).toBe('atlas-media-prod');
    });

    it('does not let the two tokens be the same value by accident of wiring', () => {
      const { media, protectedMedia } = loadWith({
        R2_PROTECTED_BUCKET: 'atlas-media-prod-protected',
        R2_PROTECTED_ACCESS_KEY_ID: PROTECTED_KEY_ID,
        R2_PROTECTED_SECRET_ACCESS_KEY: PROTECTED_SECRET,
      });
      expect(protectedMedia.accessKeyId).not.toBe(media.accessKeyId);
      expect(protectedMedia.secretAccessKey).not.toBe(media.secretAccessKey);
    });
  });

  describe('protected credentials absent', () => {
    it('falls back to the public media credentials, which is the pre-existing behaviour', () => {
      const { media, protectedMedia } = loadWith({
        R2_PROTECTED_BUCKET: 'atlas-media-prod-protected',
        R2_PROTECTED_ACCESS_KEY_ID: undefined,
        R2_PROTECTED_SECRET_ACCESS_KEY: undefined,
      });
      expect(protectedMedia.accessKeyId).toBe(media.accessKeyId);
      expect(protectedMedia.secretAccessKey).toBe(media.secretAccessKey);
    });

    it('still resolves a protected bucket, so the fallback is credentials only', () => {
      const { media, protectedMedia } = loadWith({
        R2_PROTECTED_BUCKET: undefined,
        R2_PROTECTED_ACCESS_KEY_ID: undefined,
        R2_PROTECTED_SECRET_ACCESS_KEY: undefined,
      });
      expect(protectedMedia.bucket).toBe(`${media.bucket}-protected`);
      expect(protectedMedia.bucket).not.toBe(media.bucket);
    });
  });

  describe('protected bucket resolution', () => {
    it('resolves R2_PROTECTED_BUCKET to the configured production bucket', () => {
      const { protectedMedia } = loadWith({
        R2_PROTECTED_BUCKET: 'atlas-media-prod-protected',
      });
      expect(protectedMedia.bucket).toBe('atlas-media-prod-protected');
    });

    it('never resolves the protected bucket to the public one', () => {
      const { media, protectedMedia } = loadWith({
        R2_PROTECTED_BUCKET: 'atlas-media-prod-protected',
      });
      expect(protectedMedia.bucket).not.toBe(media.bucket);
    });
  });

  describe('half-configured pair', () => {
    // A key id with no secret does not fail — it falls back to the public
    // token and keeps working, so the isolation an operator believed they
    // had would be silently absent. Refuse at startup instead.
    it('refuses a key id with no secret', () => {
      expect(() =>
        validateEnv({ ...BASE_ENV, R2_PROTECTED_ACCESS_KEY_ID: PROTECTED_KEY_ID }),
      ).toThrow(/must be set together/);
    });

    it('refuses a secret with no key id', () => {
      expect(() =>
        validateEnv({ ...BASE_ENV, R2_PROTECTED_SECRET_ACCESS_KEY: PROTECTED_SECRET }),
      ).toThrow(/must be set together/);
    });

    it('accepts both together, and accepts neither', () => {
      expect(() =>
        validateEnv({
          ...BASE_ENV,
          R2_PROTECTED_ACCESS_KEY_ID: PROTECTED_KEY_ID,
          R2_PROTECTED_SECRET_ACCESS_KEY: PROTECTED_SECRET,
        }),
      ).not.toThrow();
      expect(() => validateEnv({ ...BASE_ENV })).not.toThrow();
    });
  });
});
