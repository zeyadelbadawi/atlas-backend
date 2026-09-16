/**
 * P58 — audit before/after redaction.
 *
 * This is a SECURITY BOUNDARY, not formatting. `changes` is the one audit
 * field whose whole purpose is to record values that were previously only
 * in the database, which makes it the one field that can accidentally
 * capture a password hash, a TOTP secret or an encrypted gateway
 * credential. The scrub runs at the single writer choke point every
 * mutation funnels through, so these assert the scrub itself rather than
 * trusting any call site to behave.
 */
import { redactChanges } from './audit-log-writer.service';

describe('redactChanges (P58)', () => {
  it('passes ordinary business values through untouched', () => {
    const result = redactChanges({
      pricing: {
        from: { amount: 79, currency: 'USD', billingCycle: 'monthly' },
        to: { amount: 89, currency: 'USD', billingCycle: 'monthly' },
      },
      displayOrder: { from: 2, to: 3 },
    });

    expect(result.pricing.from).toEqual({
      amount: 79,
      currency: 'USD',
      billingCycle: 'monthly',
    });
    expect(result.displayOrder).toEqual({ from: 2, to: 3 });
  });

  it.each([
    'password',
    'passwordHash',
    'totpSecret',
    'refreshToken',
    'accessToken',
    'clientSecret',
    'encryptedCredential',
    'apiKey',
    'privateKey',
    'webhookSignature',
    'recoveryCodes',
    'passwordSalt',
    'credentialCipher',
  ])('redacts BOTH sides of a sensitive field: %s', (field) => {
    const result = redactChanges({
      [field]: { from: 'old-real-secret-value', to: 'new-real-secret-value' },
    });

    expect(result[field].from).toBe('[redacted]');
    expect(result[field].to).toBe('[redacted]');
    // The FACT of the change survives — that a credential rotated is itself
    // security-relevant and must remain auditable.
    expect(Object.keys(result)).toContain(field);
  });

  it('matches case-insensitively, so casing cannot smuggle a value through', () => {
    const result = redactChanges({
      PASSWORD: { from: 'a', to: 'b' },
      Totp_Secret: { from: 'a', to: 'b' },
    });
    expect(result.PASSWORD.from).toBe('[redacted]');
    expect(result.Totp_Secret.to).toBe('[redacted]');
  });

  it('redacts a sensitive key NESTED inside an object value', () => {
    // A plan's `pricing` is an object; a future audited object could nest a
    // credential inside it, so the scrub recurses rather than only checking
    // the top-level field name.
    const result = redactChanges({
      providerConfig: {
        from: { endpoint: 'https://example.test', clientSecret: 'real-secret' },
        to: { endpoint: 'https://example.test', clientSecret: 'rotated-secret' },
      },
    });

    const from = result.providerConfig.from as Record<string, unknown>;
    const to = result.providerConfig.to as Record<string, unknown>;
    expect(from.endpoint).toBe('https://example.test');
    expect(from.clientSecret).toBe('[redacted]');
    expect(to.clientSecret).toBe('[redacted]');
  });

  it('redacts inside arrays of objects', () => {
    const result = redactChanges({
      credentials: { from: [{ token: 'a' }], to: [{ token: 'b' }] },
    });
    // The field name itself matches a stem, so the whole value is replaced.
    expect(result.credentials.from).toBe('[redacted]');
  });

  it('handles null, undefined and primitives without throwing', () => {
    const result = redactChanges({
      description: { from: null, to: 'something' },
      trialDurationDays: { from: undefined, to: 14 },
      trialEligible: { from: false, to: true },
    });
    expect(result.description.from).toBeNull();
    expect(result.trialDurationDays.to).toBe(14);
    expect(result.trialEligible.to).toBe(true);
  });

  it('terminates on deeply nested input rather than recursing without bound', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };

    expect(() => redactChanges({ tree: { from: deep, to: deep } })).not.toThrow();
  });
});
