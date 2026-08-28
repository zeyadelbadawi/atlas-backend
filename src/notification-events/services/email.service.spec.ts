import { EmailService } from './email.service';
import type { EmailProvider } from '../../identity/services/email-provider.interface';

describe('EmailService', () => {
  it('calls the provider with the rendered template subject/text', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const provider: EmailProvider = {
      sendPasswordResetEmail: jest.fn(),
      sendTransactionalEmail: send,
    };
    const service = new EmailService(provider);

    await service.sendTemplated('student@example.com', 'course_order_paid', {
      courseTitle: 'Spanish 101',
    });

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'student@example.com', subject: expect.any(String) }),
    );
    expect(send.mock.calls[0][0].text).toContain('Spanish 101');
  });

  it('never throws when the underlying provider rejects — master plan §21 P17: "Email provider failure must not corrupt the primary business transaction"', async () => {
    const provider: EmailProvider = {
      sendPasswordResetEmail: jest.fn(),
      sendTransactionalEmail: jest
        .fn()
        .mockRejectedValue(new Error('provider unreachable')),
    };
    const service = new EmailService(provider);

    await expect(
      service.sendTemplated('student@example.com', 'password_changed', {}),
    ).resolves.toBeUndefined();
  });
});
