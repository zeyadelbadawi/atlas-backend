/**
 * `EMAIL_DELIVERABILITY_CHECK_ENABLED` is read from the raw environment, where
 * every value is a string. 'false' must switch the DNS check off; it was once
 * coalesced with `??` and so read as truthy, which made the switch a no-op.
 */
import loadConfiguration from './configuration';
import type { IdentityConfig } from './configuration';

function deliverabilityWith(overrides: Record<string, string | undefined>): boolean {
  const saved = process.env;
  try {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(overrides)) if (v !== undefined) next[k] = v;
    process.env = next as unknown as NodeJS.ProcessEnv;
    const config = loadConfiguration() as unknown as { identity: IdentityConfig };
    return config.identity.emailDeliverabilityCheckEnabled;
  } finally {
    process.env = saved;
  }
}

describe('EMAIL_DELIVERABILITY_CHECK_ENABLED', () => {
  it.each([
    ['production', 'false', false],
    ['production', 'true', true],
    ['production', undefined, true],
    ['development', undefined, true],
    ['test', undefined, false],
    ['test', 'true', true],
  ])('NODE_ENV=%s, flag=%s → %s', (nodeEnv, flag, expected) => {
    expect(
      deliverabilityWith({ NODE_ENV: nodeEnv, EMAIL_DELIVERABILITY_CHECK_ENABLED: flag }),
    ).toBe(expected);
  });
});
