import { EmailService } from './email.service';
import type { EmailProvider } from '../../identity/services/email-provider.interface';
import type { SuppressionService } from '../../communications/services/suppression.service';

function providerWith(send: jest.Mock): EmailProvider {
  return {
    name: 'test',
    capabilities: () => ({
      supportsWebhooks: false,
      supportsHtml: true,
      supportsIdempotencyKey: true,
    }),
    send,
    verifyWebhook: () => false,
    parseWebhookEvents: () => [],
    sendPasswordResetEmail: jest.fn(),
    sendEmailVerification: jest.fn(),
    sendTransactionalEmail: jest.fn(),
  };
}

function suppressionsWith(isSuppressed: boolean | Error): SuppressionService {
  return {
    isSuppressed:
      isSuppressed instanceof Error
        ? jest.fn().mockRejectedValue(isSuppressed)
        : jest.fn().mockResolvedValue(isSuppressed),
  } as unknown as SuppressionService;
}

describe('EmailService', () => {
  it('calls the provider with the rendered template subject/text and the default category', async () => {
    const send = jest.fn().mockResolvedValue({ providerMessageId: 'm1' });
    const service = new EmailService(providerWith(send), suppressionsWith(false));

    await service.sendTemplated('student@example.com', 'course_order_paid', {
      courseTitle: 'Spanish 101',
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'student@example.com',
        subject: expect.any(String),
        category: 'transactional',
      }),
    );
    expect(send.mock.calls[0][0].text).toContain('Spanish 101');
  });

  it('passes an explicit category through to the registry', async () => {
    const send = jest.fn().mockResolvedValue({ providerMessageId: 'm1' });
    const service = new EmailService(providerWith(send), suppressionsWith(false));

    await service.sendTemplated(
      's@example.com',
      'certificate_issued',
      {},
      { category: 'lifecycle' },
    );

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ category: 'lifecycle' }));
  });

  it('skips a suppressed address without touching the provider', async () => {
    const send = jest.fn();
    const service = new EmailService(providerWith(send), suppressionsWith(true));

    await service.sendTemplated('bounced@example.com', 'password_changed', {});

    expect(send).not.toHaveBeenCalled();
  });

  it('still sends when the suppression lookup itself fails', async () => {
    const send = jest.fn().mockResolvedValue({ providerMessageId: 'm1' });
    const service = new EmailService(
      providerWith(send),
      suppressionsWith(new Error('db down')),
    );

    await service.sendTemplated('s@example.com', 'password_changed', {});

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never throws when the underlying provider rejects — master plan §21 P17: "Email provider failure must not corrupt the primary business transaction"', async () => {
    const send = jest.fn().mockRejectedValue(new Error('provider unreachable'));
    const service = new EmailService(providerWith(send), suppressionsWith(false));

    await expect(
      service.sendTemplated('student@example.com', 'password_changed', {}),
    ).resolves.toBeUndefined();
  });
});
