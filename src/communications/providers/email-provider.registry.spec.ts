/** EmailProviderRegistry — fallback order, quota skipping and permanent-stop. */
import { EmailProviderRegistry } from './email-provider.registry';
import {
  EmailProviderError,
  type EmailProviderAdapter,
} from '../../identity/services/email-provider.interface';
import type { EmailQuotaService } from '../services/email-quota.service';
import type { CommunicationMetricsService } from '../services/communication-metrics.service';

function adapter(name: string, send: jest.Mock): EmailProviderAdapter {
  return {
    name,
    capabilities: () => ({
      dailyLimit: 10,
      supportsWebhooks: true,
      supportsHtml: true,
      supportsIdempotencyKey: true,
    }),
    send,
    verifyWebhook: () => false,
    parseWebhookEvents: () => [],
  };
}

function harness(decisions: Record<string, { ok: boolean; reason?: string }> = {}) {
  const reserve = jest.fn(
    async (provider: string) => decisions[provider] ?? { ok: true },
  );
  const recordAccepted = jest.fn().mockResolvedValue(undefined);
  const recordSend = jest.fn();
  const quota = { reserve, recordAccepted } as unknown as EmailQuotaService;
  const metrics = { recordSend } as unknown as CommunicationMetricsService;
  return { quota, metrics, reserve, recordAccepted, recordSend };
}

const input = { to: 'a@example.com', subject: 's', text: 't' };

describe('EmailProviderRegistry', () => {
  it('sends through the first provider and records the accepted send', async () => {
    const h = harness();
    const primary = jest.fn().mockResolvedValue({ providerMessageId: 'p1' });
    const fallback = jest.fn();
    const registry = new EmailProviderRegistry(
      [adapter('brevo', primary), adapter('resend', fallback)],
      h.quota,
      h.metrics,
    );

    await expect(registry.send({ ...input, category: 'lifecycle' })).resolves.toEqual({
      providerMessageId: 'p1',
      provider: 'brevo',
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(h.reserve).toHaveBeenCalledWith('brevo', 'lifecycle', expect.any(Object));
    expect(h.recordAccepted).toHaveBeenCalledWith('brevo', expect.any(Object));
    expect(h.recordSend).toHaveBeenCalledWith('brevo', 'lifecycle', 'sent');
  });

  it('falls through to the next provider on a transient error', async () => {
    const h = harness();
    const primary = jest
      .fn()
      .mockRejectedValue(new EmailProviderError('brevo', 'transient', 'HTTP 503', 503));
    const fallback = jest.fn().mockResolvedValue({ providerMessageId: 'r1' });
    const registry = new EmailProviderRegistry(
      [adapter('brevo', primary), adapter('resend', fallback)],
      h.quota,
      h.metrics,
    );

    await expect(registry.send(input)).resolves.toEqual({
      providerMessageId: 'r1',
      provider: 'resend',
    });
    expect(h.recordSend).toHaveBeenCalledWith(
      'brevo',
      'transactional',
      'transient_error',
    );
    expect(h.recordAccepted).toHaveBeenCalledTimes(1);
    expect(h.recordAccepted).toHaveBeenCalledWith('resend', expect.any(Object));
  });

  it('treats an unknown thrown error as transient too', async () => {
    const h = harness();
    const primary = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const fallback = jest.fn().mockResolvedValue({ providerMessageId: 'r1' });
    const registry = new EmailProviderRegistry(
      [adapter('brevo', primary), adapter('resend', fallback)],
      h.quota,
      h.metrics,
    );
    await expect(registry.send(input)).resolves.toMatchObject({ provider: 'resend' });
  });

  it('skips a provider whose quota line is exhausted without calling it', async () => {
    const h = harness({ brevo: { ok: false, reason: 'daily' } });
    const primary = jest.fn();
    const fallback = jest.fn().mockResolvedValue({ providerMessageId: 'r1' });
    const registry = new EmailProviderRegistry(
      [adapter('brevo', primary), adapter('resend', fallback)],
      h.quota,
      h.metrics,
    );

    await expect(
      registry.send({ ...input, category: 'engagement' }),
    ).resolves.toMatchObject({
      provider: 'resend',
    });
    expect(primary).not.toHaveBeenCalled();
    expect(h.recordSend).toHaveBeenCalledWith('brevo', 'engagement', 'quota_skipped');
  });

  it('stops at a permanent error and does not try the fallback', async () => {
    const h = harness();
    const primary = jest
      .fn()
      .mockRejectedValue(new EmailProviderError('brevo', 'permanent', 'HTTP 400', 400));
    const fallback = jest.fn();
    const registry = new EmailProviderRegistry(
      [adapter('brevo', primary), adapter('resend', fallback)],
      h.quota,
      h.metrics,
    );

    await expect(registry.send(input)).rejects.toMatchObject({
      kind: 'permanent',
      status: 400,
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(h.recordSend).toHaveBeenCalledWith(
      'brevo',
      'transactional',
      'permanent_error',
    );
  });

  it('throws the last transient error when every provider fails, and a transient "exhausted" error when every provider is skipped', async () => {
    const h = harness();
    const failing = jest
      .fn()
      .mockRejectedValue(new EmailProviderError('x', 'transient', 'HTTP 502', 502));
    const registry = new EmailProviderRegistry(
      [adapter('brevo', failing), adapter('resend', failing)],
      h.quota,
      h.metrics,
    );
    await expect(registry.send(input)).rejects.toMatchObject({
      kind: 'transient',
      status: 502,
    });

    const skipped = harness({
      brevo: { ok: false, reason: 'daily' },
      resend: { ok: false, reason: 'monthly' },
    });
    const registry2 = new EmailProviderRegistry(
      [adapter('brevo', jest.fn()), adapter('resend', jest.fn())],
      skipped.quota,
      skipped.metrics,
    );
    await expect(registry2.send(input)).rejects.toMatchObject({ kind: 'transient' });
  });

  it('legacy methods delegate to send() with the security category and the token in the body only', async () => {
    const h = harness();
    const send = jest.fn().mockResolvedValue({ providerMessageId: 'p1' });
    const registry = new EmailProviderRegistry(
      [adapter('stub', send)],
      h.quota,
      h.metrics,
    );

    await registry.sendPasswordResetEmail('a@example.com', 'tok-reset');
    await registry.sendEmailVerification('a@example.com', 'tok-verify');
    await registry.sendTransactionalEmail({
      to: 'a@example.com',
      subject: 'S',
      text: 'T',
    });

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0]).toMatchObject({
      category: 'security',
      tags: ['password_reset'],
    });
    expect(send.mock.calls[0][0].text).toContain('tok-reset');
    expect(JSON.stringify(send.mock.calls[0][0].tags)).not.toContain('tok-reset');
    expect(send.mock.calls[1][0]).toMatchObject({
      category: 'security',
      tags: ['email_verification'],
    });
    expect(send.mock.calls[2][0]).toMatchObject({
      category: 'transactional',
      subject: 'S',
    });
  });

  it('exposes the chain order and finds adapters by name', () => {
    const h = harness();
    const registry = new EmailProviderRegistry(
      [adapter('brevo', jest.fn()), adapter('resend', jest.fn())],
      h.quota,
      h.metrics,
    );
    expect(registry.providerNames()).toEqual(['brevo', 'resend']);
    expect(registry.find('resend')?.name).toBe('resend');
    expect(registry.find('stub')).toBeUndefined();
    expect(registry.capabilities().dailyLimit).toBe(20);
  });

  it('refuses an empty chain', () => {
    const h = harness();
    expect(() => new EmailProviderRegistry([], h.quota, h.metrics)).toThrow(
      /at least one provider/,
    );
  });
});
