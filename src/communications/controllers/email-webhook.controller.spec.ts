/**
 * EmailWebhookController — the public, unauthenticated inbound route.
 * `verifyWebhook` on the named adapter IS the authorization boundary, so
 * these tests care about exactly one thing: nothing is written before a
 * real signature over the RAW bytes has been verified.
 *
 * The Resend half is driven through the real `ResendEmailProvider` with a
 * real Svix signature rather than a stubbed `verifyWebhook`, so the route
 * and the adapter are proven to agree.
 */
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { EmailWebhookController } from './email-webhook.controller';
import { ResendEmailProvider } from '../providers/resend-email.provider';
import { StubEmailProvider } from '../providers/stub-email.provider';
import type { CommunicationsWebhookProducer } from '../queue/communications-webhook.producer';
import type { CommunicationMetricsService } from '../services/communication-metrics.service';
import type { EmailProviderAdapter } from '../../identity/services/email-provider.interface';

const RAW_SECRET = Buffer.from('resend-webhook-secret-fixed-for-tests').toString(
  'base64',
);

const config = {
  getOrThrow: () => ({
    resendApiKey: 're_test',
    fromEmail: 'owner@example.com',
    fromName: 'Atlas',
    resendWebhookSecret: `whsec_${RAW_SECRET}`,
  }),
} as unknown as ConfigService;

function svixHeaders(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', Buffer.from(RAW_SECRET, 'base64'))
    .update(`msg_1.${timestamp}.${body}`)
    .digest('base64');
  return {
    'svix-id': 'msg_1',
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${signature}`,
  };
}

function request(rawBody: string | undefined, headers: Record<string, string> = {}) {
  return {
    headers,
    rawBody: rawBody === undefined ? undefined : Buffer.from(rawBody),
  } as unknown as Request & { rawBody?: Buffer };
}

describe('EmailWebhookController (resend)', () => {
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const recordWebhookSignatureFailure = jest.fn();
  const producer = { enqueue } as unknown as CommunicationsWebhookProducer;
  const metrics = {
    recordWebhookSignatureFailure,
  } as unknown as CommunicationMetricsService;

  function controller(adapters: readonly EmailProviderAdapter[]) {
    return new EmailWebhookController(adapters, producer, metrics);
  }

  const resend = () => new ResendEmailProvider(config);

  const payload = JSON.stringify({
    type: 'email.delivered',
    created_at: '2026-09-24T10:00:00.000Z',
    data: { email_id: 'em_123', to: ['learner@example.com'] },
  });

  beforeEach(() => {
    enqueue.mockClear();
    recordWebhookSignatureFailure.mockClear();
  });

  it('accepts a correctly signed event and enqueues it', async () => {
    await expect(
      controller([resend()]).handle(
        'resend',
        undefined,
        request(payload, svixHeaders(payload)),
      ),
    ).resolves.toEqual({ received: true, events: 1 });
    expect(enqueue).toHaveBeenCalledWith({
      provider: 'resend',
      providerMessageId: 'em_123',
      recipientEmail: 'learner@example.com',
      event: 'delivered',
      occurredAt: '2026-09-24T10:00:00.000Z',
      reason: undefined,
    });
  });

  it('matches the provider name case-insensitively', async () => {
    await expect(
      controller([resend()]).handle(
        'RESEND',
        undefined,
        request(payload, svixHeaders(payload)),
      ),
    ).resolves.toMatchObject({ received: true });
  });

  it('rejects an invalid signature, writes nothing and counts the failure', async () => {
    const headers = svixHeaders(payload);
    headers['svix-signature'] = 'v1,AAAA';
    await expect(
      controller([resend()]).handle('resend', undefined, request(payload, headers)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(enqueue).not.toHaveBeenCalled();
    expect(recordWebhookSignatureFailure).toHaveBeenCalledWith('resend');
  });

  it('rejects a replayed timestamp outside the tolerance window', async () => {
    const stale = svixHeaders(payload, Math.floor(Date.now() / 1000) - 3600);
    await expect(
      controller([resend()]).handle('resend', undefined, request(payload, stale)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('verifies the RAW bytes — a body that differs by a byte is refused', async () => {
    const headers = svixHeaders(payload);
    await expect(
      controller([resend()]).handle(
        'resend',
        undefined,
        request(`${payload}\n`, headers),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('fails closed when the raw body was never captured', async () => {
    await expect(
      controller([resend()]).handle(
        'resend',
        undefined,
        request(undefined, svixHeaders(payload)),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('FAILS CLOSED when RESEND_WEBHOOK_SECRET is unset', async () => {
    const withoutSecret = new ResendEmailProvider({
      getOrThrow: () => ({ resendWebhookSecret: undefined }),
    } as unknown as ConfigService);
    await expect(
      controller([withoutSecret]).handle(
        'resend',
        undefined,
        request(payload, svixHeaders(payload)),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('accepts a verified request whose body is not JSON, but enqueues nothing', async () => {
    const body = 'not json at all';
    await expect(
      controller([resend()]).handle(
        'resend',
        undefined,
        request(body, svixHeaders(body)),
      ),
    ).resolves.toEqual({ received: true, events: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('accepts a verified request whose JSON carries no usable event', async () => {
    const body = JSON.stringify({ type: 'email.sent', data: { email_id: 'x' } });
    await expect(
      controller([resend()]).handle(
        'resend',
        undefined,
        request(body, svixHeaders(body)),
      ),
    ).resolves.toEqual({ received: true, events: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('404s an unknown provider and any adapter that does not do webhooks', async () => {
    await expect(
      controller([resend()]).handle('mailgun', undefined, request(payload)),
    ).rejects.toBeInstanceOf(NotFoundException);
    // The stub advertises `supportsWebhooks: false`, so its route does not exist.
    await expect(
      controller([new StubEmailProvider()]).handle('stub', undefined, request(payload)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
