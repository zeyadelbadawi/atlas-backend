import loadConfiguration from './configuration';
import { validateEnv } from './env.validation';
import type { VideoProviderConfig } from './configuration';

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
};

function videoConfig(env: Record<string, string>): VideoProviderConfig {
  const saved = process.env;
  try {
    process.env = env as unknown as NodeJS.ProcessEnv;
    return (loadConfiguration() as unknown as { video: VideoProviderConfig }).video;
  } finally {
    process.env = saved;
  }
}

describe('Premium video playback-token lifetime (W5)', () => {
  // The Stream token is an unbound bearer credential; its lifetime is the
  // whole revocation window. It used to default to two hours.
  it('defaults to ten minutes, the same life as the Normal tier and file presigns', () => {
    expect(videoConfig(BASE_ENV).playbackTokenTtlSeconds).toBe(600);
    expect(validateEnv(BASE_ENV).VIDEO_PLAYBACK_TOKEN_TTL_SECONDS).toBe(600);
  });

  it('still honours an explicit value within the ceiling', () => {
    const env = { ...BASE_ENV, VIDEO_PLAYBACK_TOKEN_TTL_SECONDS: '900' };
    expect(videoConfig(env).playbackTokenTtlSeconds).toBe(900);
    expect(() =>
      validateEnv({ ...BASE_ENV, VIDEO_PLAYBACK_TOKEN_TTL_SECONDS: '7201' }),
    ).toThrow(/VIDEO_PLAYBACK_TOKEN_TTL_SECONDS/);
  });
});
