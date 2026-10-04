/** EmailProviderRegistry — fallback order, quota skipping and permanent-stop. */
import {
  EmailProviderRegistry,
  buildProviderChain,
  quotaResetAt,
} from './email-provider.registry';
import {
  EmailProviderError,
  EmailQuotaExhaustedError,
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

  it('still delegates the one remaining legacy convenience to send()', async () => {
    // `sendPasswordResetEmail`/`sendEmailVerification` were REMOVED: they
    // composed their own body and pasted the raw token into it, which is
    // how a recipient ended up holding an internal credential with no
    // action. Both flows emit their catalogue event now. Only the generic
    // transactional convenience remains.
    const h = harness();
    const send = jest.fn().mockResolvedValue({ providerMessageId: 'p1' });
    const registry = new EmailProviderRegistry(
      [adapter('stub', send)],
      h.quota,
      h.metrics,
    );

    await registry.sendTransactionalEmail({
      to: 'a@example.com',
      subject: 'S',
      text: 'T',
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
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

/**
 * W-RESEND fallback matrix — the behaviour the approved production chain
 * (`EMAIL_PROVIDERS=brevo,resend`: Brevo PRIMARY, Resend FALLBACK) depends
 * on, asserted directly rather than inferred. Production currently runs
 * `EMAIL_PROVIDERS=brevo`; these tests are what makes adding `resend` a
 * configuration change rather than a leap of faith.
 */
describe('EmailProviderRegistry — brevo → resend fallback matrix', () => {
  /** Realistic free-tier capabilities for the two real adapters. */
  function realAdapter(name: 'brevo' | 'resend', send: jest.Mock): EmailProviderAdapter {
    const caps =
      name === 'brevo'
        ? { dailyLimit: 300, monthlyLimit: 9000, perSecond: 5 }
        : { dailyLimit: 100, monthlyLimit: 3000, perSecond: 2 };
    return {
      name,
      capabilities: () => ({
        ...caps,
        supportsWebhooks: true,
        supportsHtml: true,
        supportsIdempotencyKey: name === 'resend',
      }),
      send,
      verifyWebhook: () => false,
      parseWebhookEvents: () => [],
    };
  }

  function chain(
    brevoSend: jest.Mock,
    resendSend: jest.Mock,
    decisions: Record<string, { ok: boolean; reason?: string }> = {},
  ) {
    const h = harness(decisions);
    return {
      h,
      registry: new EmailProviderRegistry(
        [realAdapter('brevo', brevoSend), realAdapter('resend', resendSend)],
        h.quota,
        h.metrics,
      ),
    };
  }

  it('A Brevo TRANSIENT failure falls through to Resend and the send succeeds', async () => {
    const brevo = jest
      .fn()
      .mockRejectedValue(new EmailProviderError('brevo', 'transient', 'HTTP 503', 503));
    const resend = jest.fn().mockResolvedValue({ providerMessageId: 'em_1' });
    const { h, registry } = chain(brevo, resend);

    await expect(registry.send(input)).resolves.toEqual({
      providerMessageId: 'em_1',
      provider: 'resend',
    });
    expect(brevo).toHaveBeenCalledTimes(1);
    expect(resend).toHaveBeenCalledTimes(1);
    expect(h.recordSend).toHaveBeenCalledWith('resend', 'transactional', 'sent');
    expect(h.recordAccepted).toHaveBeenCalledTimes(1);
    expect(h.recordAccepted).toHaveBeenCalledWith('resend', expect.any(Object));
  });

  it('A Brevo network failure (no status) also falls through to Resend', async () => {
    const brevo = jest
      .fn()
      .mockRejectedValue(
        new EmailProviderError('brevo', 'transient', 'brevo: request failed (TypeError)'),
      );
    const resend = jest.fn().mockResolvedValue({ providerMessageId: 'em_1' });
    const { registry } = chain(brevo, resend);
    await expect(registry.send(input)).resolves.toMatchObject({ provider: 'resend' });
  });

  it('A Brevo PERMANENT rejection stops the chain — Resend is never asked', async () => {
    const brevo = jest
      .fn()
      .mockRejectedValue(
        new EmailProviderError('brevo', 'permanent', 'HTTP 400 (invalid_parameter)', 400),
      );
    const resend = jest.fn();
    const { h, registry } = chain(brevo, resend);

    await expect(registry.send(input)).rejects.toMatchObject({
      provider: 'brevo',
      kind: 'permanent',
      status: 400,
    });
    expect(resend).not.toHaveBeenCalled();
    expect(h.recordAccepted).not.toHaveBeenCalled();
    expect(h.recordSend).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'sent',
    );
  });

  it('Brevo quota exhaustion falls through to Resend without calling Brevo at all', async () => {
    const brevo = jest.fn();
    const resend = jest.fn().mockResolvedValue({ providerMessageId: 'em_1' });
    const { h, registry } = chain(brevo, resend, {
      brevo: { ok: false, reason: 'daily' },
    });

    await expect(
      registry.send({ ...input, category: 'security' }),
    ).resolves.toMatchObject({ provider: 'resend' });
    expect(brevo).not.toHaveBeenCalled();
    expect(h.recordSend).toHaveBeenCalledWith('brevo', 'security', 'quota_skipped');
    // Quota is only burned at the provider that actually accepted.
    expect(h.recordAccepted).toHaveBeenCalledTimes(1);
    expect(h.recordAccepted).toHaveBeenCalledWith('resend', expect.any(Object));
  });

  it('Brevo quota exhausted AND Resend transient surfaces the real Resend error, not a generic one', async () => {
    const resend = jest
      .fn()
      .mockRejectedValue(
        new EmailProviderError(
          'resend',
          'transient',
          'resend: HTTP 429 (rate_limit_exceeded)',
          429,
          2000,
        ),
      );
    const { h, registry } = chain(jest.fn(), resend, {
      brevo: { ok: false, reason: 'monthly' },
    });

    const error = (await registry.send(input).catch((e: unknown) => e)) as Error & {
      provider?: string;
      retryAfterMs?: number;
    };
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.provider).toBe('resend');
    expect(error.retryAfterMs).toBe(2000);
    expect(h.recordAccepted).not.toHaveBeenCalled();
  });

  it('BOTH providers failing transiently throws the last real error — nothing silently succeeds', async () => {
    const brevo = jest
      .fn()
      .mockRejectedValue(new EmailProviderError('brevo', 'transient', 'HTTP 503', 503));
    const resend = jest
      .fn()
      .mockRejectedValue(
        new EmailProviderError(
          'resend',
          'transient',
          'resend: HTTP 500 (application_error)',
          500,
        ),
      );
    const { h, registry } = chain(brevo, resend);

    const error = (await registry.send(input).catch((e: unknown) => e)) as Error & {
      provider?: string;
      kind?: string;
      status?: number;
    };
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.kind).toBe('transient');
    expect(error.provider).toBe('resend');
    expect(error.status).toBe(500);
    expect(brevo).toHaveBeenCalledTimes(1);
    expect(resend).toHaveBeenCalledTimes(1);
    // No accepted send, no `sent` metric, no message id handed back.
    expect(h.recordAccepted).not.toHaveBeenCalled();
    expect(h.recordSend).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'sent',
    );
  });

  it('A Brevo transient followed by a Resend PERMANENT throws the permanent error honestly', async () => {
    const brevo = jest
      .fn()
      .mockRejectedValue(new EmailProviderError('brevo', 'transient', 'HTTP 503', 503));
    const resend = jest
      .fn()
      .mockRejectedValue(
        new EmailProviderError(
          'resend',
          'permanent',
          'resend: HTTP 422 (validation_error)',
          422,
        ),
      );
    const { h, registry } = chain(brevo, resend);

    await expect(registry.send(input)).rejects.toMatchObject({
      provider: 'resend',
      kind: 'permanent',
      status: 422,
    });
    expect(h.recordAccepted).not.toHaveBeenCalled();
  });

  it('BOTH providers out of quota throws a transient "exhausted" error, never a success', async () => {
    const { h, registry } = chain(jest.fn(), jest.fn(), {
      brevo: { ok: false, reason: 'daily' },
      resend: { ok: false, reason: 'daily' },
    });
    await expect(registry.send(input)).rejects.toMatchObject({
      kind: 'transient',
      provider: 'registry',
    });
    expect(h.recordAccepted).not.toHaveBeenCalled();
  });

  it('sums the two free tiers and reports idempotency only when every member supports it', () => {
    const { registry } = chain(jest.fn(), jest.fn());
    expect(registry.capabilities()).toEqual({
      dailyLimit: 400,
      monthlyLimit: 12_000,
      perSecond: 7,
      supportsWebhooks: true,
      supportsHtml: true,
      // Brevo has no idempotency key, so the chain cannot promise one.
      supportsIdempotencyKey: false,
    });
    expect(registry.providerNames()).toEqual(['brevo', 'resend']);
  });
});

describe('buildProviderChain', () => {
  const stub = adapter('stub', jest.fn());
  const brevo = adapter('brevo', jest.fn());
  const resend = adapter('resend', jest.fn());
  const byName = { stub, brevo, resend };

  it('builds exactly the chain EMAIL_PROVIDERS names, in order', () => {
    expect(buildProviderChain(['brevo', 'resend'], byName).map((a) => a.name)).toEqual([
      'brevo',
      'resend',
    ]);
    expect(buildProviderChain(['resend', 'brevo'], byName).map((a) => a.name)).toEqual([
      'resend',
      'brevo',
    ]);
  });

  it('never appends the stub to a production chain — a silent local "success" is worse than a failure', () => {
    for (const order of [['brevo'], ['brevo', 'resend'], ['resend']]) {
      const names = buildProviderChain(order, byName).map((a) => a.name);
      expect(names).not.toContain('stub');
    }
    // It is reachable only when an operator asks for it by name.
    expect(buildProviderChain(['stub'], byName).map((a) => a.name)).toEqual(['stub']);
  });

  it('takes a repeated provider once, so the chain cannot advertise twice the budget it has', () => {
    expect(
      buildProviderChain(['brevo', 'brevo', 'resend', 'BREVO'], byName).map(
        (a) => a.name,
      ),
    ).toEqual(['brevo', 'resend']);
  });

  it('drops names with no adapter behind them rather than crashing the boot', () => {
    expect(
      buildProviderChain(['brevo', 'mailgun', '', '  ', 'resend'], byName).map(
        (a) => a.name,
      ),
    ).toEqual(['brevo', 'resend']);
    expect(buildProviderChain([], byName)).toEqual([]);
  });
});

describe('W3-compose — quota exhaustion is a distinct, deferrable error', () => {
  it('throws EmailQuotaExhaustedError with the earliest reset when every provider is out of quota', async () => {
    const h = harness({
      brevo: { ok: false, reason: 'monthly' },
      resend: { ok: false, reason: 'daily' },
    });
    const send = jest.fn();
    const registry = new EmailProviderRegistry(
      [adapter('brevo', send), adapter('resend', send)],
      h.quota,
      h.metrics,
    );
    const before = new Date();
    const error = await registry
      .send({ ...input, category: 'engagement' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(EmailQuotaExhaustedError);
    // Still an EmailProviderError of kind transient: older callers are unchanged.
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.kind).toBe('transient');
    expect(error.reason).toBe('daily');
    expect(error.retryAt.getTime()).toBe(quotaResetAt('daily', before).getTime());
    expect(send).not.toHaveBeenCalled();
  });

  it('surfaces a real provider error rather than the quota error when one provider was tried', async () => {
    const h = harness({ brevo: { ok: false, reason: 'daily' } });
    const resend = jest
      .fn()
      .mockRejectedValue(new EmailProviderError('resend', 'transient', 'HTTP 503', 503));
    const registry = new EmailProviderRegistry(
      [adapter('brevo', jest.fn()), adapter('resend', resend)],
      h.quota,
      h.metrics,
    );
    const error = await registry.send(input).catch((e) => e);
    expect(error).not.toBeInstanceOf(EmailQuotaExhaustedError);
    expect(error.provider).toBe('resend');
  });

  it('computes UTC reset instants for each window', () => {
    const now = new Date(Date.UTC(2026, 9, 31, 22, 15, 30, 400));
    expect(quotaResetAt('daily', now).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(quotaResetAt('monthly', now).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(quotaResetAt('rate', now).toISOString()).toBe('2026-10-31T22:15:31.000Z');
    const mid = new Date(Date.UTC(2026, 11, 15, 9));
    expect(quotaResetAt('monthly', mid).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});
