import { StubEmailProvider } from './stub-email.provider';
import {
  EMAIL_VERIFICATION_EVENT_TAG,
  PASSWORD_RESET_EVENT_TAG,
} from './legacy-messages';

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

  it('recovers a credential token from the LINK, not from a pasted line', async () => {
    // The emails no longer paste the token into the body; they render a
    // CTA whose href carries it. The peek helpers follow that link the
    // way a person would, so this spec sends the shape the outbox
    // actually produces — a catalogue-key tag and a real URL.
    const stub = new StubEmailProvider();
    await stub.send({
      to: 'User@Example.com',
      subject: 'Reset your password',
      text: 'Reset your password: https://atlas.test/auth/reset-password?token=reset-token',
      html: '<a href="https://atlas.test/auth/reset-password?token=reset-token">Reset password</a>',
      tags: [PASSWORD_RESET_EVENT_TAG],
    });
    await stub.send({
      to: 'user@example.com',
      subject: 'Verify your email',
      text: 'Verify: https://atlas.test/auth/verify-email?token=verify-token',
      html: '<a href="https://atlas.test/auth/verify-email?token=verify-token">Verify email</a>',
      tags: [EMAIL_VERIFICATION_EVENT_TAG],
    });
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
