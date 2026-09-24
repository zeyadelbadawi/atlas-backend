import { StubEmailProvider } from './stub-email.provider';
import { buildEmailVerificationEmail, buildPasswordResetEmail } from './legacy-messages';

describe('StubEmailProvider', () => {
  it('is unlimited and webhook-less', () => {
    const stub = new StubEmailProvider();
    expect(stub.capabilities()).toEqual({
      supportsWebhooks: false,
      supportsHtml: true,
      supportsIdempotencyKey: true,
    });
    expect(stub.verifyWebhook({}, '{}')).toBe(false);
    expect(stub.parseWebhookEvents({})).toEqual([]);
  });

  it('records sends and lets the peek helpers recover the legacy tokens (normalised address)', async () => {
    const stub = new StubEmailProvider();
    await stub.send(buildPasswordResetEmail('User@Example.com', 'reset-token'));
    await stub.send(buildEmailVerificationEmail('user@example.com', 'verify-token'));
    const result = await stub.send({
      to: 'user@example.com',
      subject: 'Hi',
      text: 'Body',
    });

    expect(result.providerMessageId).toMatch(/^stub-/);
    expect(stub.peekLastPasswordResetToken('user@example.com')).toBe('reset-token');
    expect(stub.peekLastEmailVerificationToken('USER@example.com')).toBe('verify-token');
    expect(stub.peekLastTransactionalEmail('user@example.com')).toMatchObject({
      subject: 'Hi',
    });
    expect(stub.recordedSends()).toHaveLength(3);
  });
});
