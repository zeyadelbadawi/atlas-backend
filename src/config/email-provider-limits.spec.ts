/**
 * B0-MSG-01 — email provider limits come from configuration. Unset keeps
 * the free tiers, so nothing changes until a paid tier is bought and its
 * numbers are set; a non-positive or non-integer value refuses to boot.
 */
import loadConfiguration from './configuration';
import type { EmailConfig } from './configuration';
import { validateEnv } from './env.validation';

function limitsWith(overrides: Record<string, string>): EmailConfig['limits'] {
  const saved = process.env;
  try {
    process.env = { ...overrides } as unknown as NodeJS.ProcessEnv;
    return (loadConfiguration() as unknown as { email: EmailConfig }).email.limits;
  } finally {
    process.env = saved;
  }
}

const VALID_BASE = {
  DATABASE_URL: 'postgresql://atlas:pw@localhost:5432/atlas_dev',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'unit-test-secret-at-least-32-characters-long',
  APP_DATABASE_URL: 'postgresql://atlas_app:pw@localhost:5432/atlas_dev',
  R2_ENDPOINT: 'http://localhost:9000',
  R2_ACCESS_KEY_ID: 'unit-test-access-key',
  R2_SECRET_ACCESS_KEY: 'unit-test-secret-key',
  R2_BUCKET: 'atlas-media-test',
  R2_PUBLIC_URL_BASE: 'http://localhost:9000/atlas-media-test',
  PAYMENT_WEBHOOK_SECRET: 'unit-test-webhook-secret-at-least-32-chars',
  PAYMENT_CREDENTIALS_ENCRYPTION_KEY:
    'fdd0676972987fc315cf21cfbc8b1e030a082597f61fcd9073174ddb92b472b1',
  NODE_ENV: 'development',
};

describe('email provider limits (B0-MSG-01)', () => {
  it('defaults to the published free tiers', () => {
    expect(limitsWith({})).toEqual({
      brevo: { dailyLimit: 300, monthlyLimit: 9000, perSecond: 5 },
      resend: { dailyLimit: 100, monthlyLimit: 3000, perSecond: 2 },
    });
  });

  it('reads each limit from its own variable, as a number', () => {
    expect(
      limitsWith({
        BREVO_DAILY_LIMIT: '20000',
        BREVO_MONTHLY_LIMIT: '600000',
        RESEND_PER_SECOND: '10',
      }),
    ).toEqual({
      brevo: { dailyLimit: 20000, monthlyLimit: 600000, perSecond: 5 },
      resend: { dailyLimit: 100, monthlyLimit: 3000, perSecond: 10 },
    });
  });

  it('accepts positive integers at boot and refuses anything else', () => {
    expect(() =>
      validateEnv({ ...VALID_BASE, BREVO_DAILY_LIMIT: '20000' }),
    ).not.toThrow();
    for (const bad of ['0', '-5', '1.5', 'lots']) {
      expect(() => validateEnv({ ...VALID_BASE, BREVO_DAILY_LIMIT: bad })).toThrow(
        /BREVO_DAILY_LIMIT/,
      );
    }
  });
});
