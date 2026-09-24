/** ResendEmailProvider — unit coverage against a mocked global `fetch` and a fixed Svix secret. */
import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { ResendEmailProvider } from './resend-email.provider';
import { EmailProviderError } from '../../identity/services/email-provider.interface';

const RAW_SECRET = Buffer.from('resend-webhook-secret-fixed-for-tests').toString(
  'base64',
);
const SECRET = `whsec_${RAW_SECRET}`;

function configWith(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    getOrThrow: () => ({
      provider: 'resend',
      providers: ['resend'],
      resendApiKey: 're_test',
      fromEmail: 'owner@example.com',
      fromName: 'Atlas',
      resendWebhookSecret: SECRET,
      ...overrides,
    }),
  } as unknown as ConfigService;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function svixHeaders(
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
  id = 'msg_1',
) {
  const signature = createHmac('sha256', Buffer.from(RAW_SECRET, 'base64'))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${signature}`,
  };
}

describe('ResendEmailProvider', () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('declares the Resend free-tier capabilities', () => {
    expect(new ResendEmailProvider(configWith()).capabilities()).toEqual({
      dailyLimit: 100,
      monthlyLimit: 3000,
      perSecond: 2,
      supportsWebhooks: true,
      supportsHtml: true,
      supportsIdempotencyKey: true,
    });
  });

  it('POSTs with Bearer auth and Idempotency-Key and returns the id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'em_123' }));
    const result = await new ResendEmailProvider(configWith()).send({
      to: 'learner@example.com',
      subject: 'Hello',
      text: 'plain',
      idempotencyKey: 'outbox-1',
      replyTo: 'reply@example.com',
    });
    expect(result).toEqual({ providerMessageId: 'em_123', provider: 'resend' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_test');
    expect(headers['Idempotency-Key']).toBe('outbox-1');
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'Atlas <owner@example.com>',
      to: ['learner@example.com'],
      subject: 'Hello',
      text: 'plain',
      reply_to: 'reply@example.com',
    });
  });

  it('accepts the legacy EMAIL_API_KEY when RESEND_API_KEY is unset', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'em_1' }));
    await new ResendEmailProvider(
      configWith({ resendApiKey: undefined, apiKey: 're_legacy' }),
    ).send({ to: 'a@example.com', subject: 's', text: 't' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer re_legacy',
    );
  });

  it('429 + Retry-After → transient with retryAfterMs', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { name: 'rate_limit_exceeded' }, { 'retry-after': '2' }),
    );
    const error = await new ResendEmailProvider(configWith())
      .send({ to: 'a@example.com', subject: 's', text: 't' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as EmailProviderError,
      );
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.kind).toBe('transient');
    expect(error.retryAfterMs).toBe(2000);
  });

  it('5xx → transient, 4xx → permanent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    const transient = await new ResendEmailProvider(configWith())
      .send({ to: 'a@example.com', subject: 's', text: 't' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as EmailProviderError,
      );
    expect(transient.kind).toBe('transient');

    fetchMock.mockResolvedValueOnce(jsonResponse(422, { name: 'validation_error' }));
    const permanent = await new ResendEmailProvider(configWith())
      .send({ to: 'a@example.com', subject: 's', text: 't' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as EmailProviderError,
      );
    expect(permanent.kind).toBe('permanent');
    expect(permanent.status).toBe(422);
  });

  describe('Svix webhook verification', () => {
    const body = JSON.stringify({
      type: 'email.bounced',
      created_at: '2026-09-24T10:00:00.000Z',
      data: {
        email_id: 'em_123',
        to: ['bounced@example.com'],
        bounce: { type: 'Permanent', message: 'no such user' },
      },
    });

    it('passes with a valid signature over id.timestamp.body', () => {
      const provider = new ResendEmailProvider(configWith());
      expect(provider.verifyWebhook(svixHeaders(body), body)).toBe(true);
    });

    it('accepts one valid entry among several space-separated signatures', () => {
      const provider = new ResendEmailProvider(configWith());
      const headers = svixHeaders(body);
      headers['svix-signature'] = `v1,AAAA ${headers['svix-signature']}`;
      expect(provider.verifyWebhook(headers, body)).toBe(true);
    });

    it('fails on a tampered body, a wrong secret, a stale timestamp or missing headers', () => {
      const provider = new ResendEmailProvider(configWith());
      expect(provider.verifyWebhook(svixHeaders(body), `${body} `)).toBe(false);
      expect(
        new ResendEmailProvider(
          configWith({ resendWebhookSecret: 'whsec_b3RoZXI=' }),
        ).verifyWebhook(svixHeaders(body), body),
      ).toBe(false);
      expect(
        provider.verifyWebhook(
          svixHeaders(body, Math.floor(Date.now() / 1000) - 600),
          body,
        ),
      ).toBe(false);
      expect(provider.verifyWebhook({}, body)).toBe(false);
      expect(
        new ResendEmailProvider(
          configWith({ resendWebhookSecret: undefined }),
        ).verifyWebhook(svixHeaders(body), body),
      ).toBe(false);
    });

    it('parses Resend events, mapping transient bounces to soft_bounced', () => {
      const provider = new ResendEmailProvider(configWith());
      expect(provider.parseWebhookEvents(JSON.parse(body))).toEqual([
        {
          providerMessageId: 'em_123',
          recipientEmail: 'bounced@example.com',
          event: 'bounced',
          occurredAt: new Date('2026-09-24T10:00:00.000Z'),
          reason: 'no such user',
        },
      ]);
      const soft = provider.parseWebhookEvents({
        type: 'email.bounced',
        data: { email_id: 'em_2', to: ['a@x.io'], bounce: { type: 'Transient' } },
      });
      expect(soft[0].event).toBe('soft_bounced');
      for (const [type, expected] of [
        ['email.delivered', 'delivered'],
        ['email.complained', 'complained'],
        ['email.opened', 'opened'],
        ['email.clicked', 'clicked'],
        ['email.delivery_delayed', 'soft_bounced'],
      ] as const) {
        expect(
          provider.parseWebhookEvents({
            type,
            data: { email_id: 'x', to: ['a@x.io'] },
          })[0].event,
        ).toBe(expected);
      }
      expect(
        provider.parseWebhookEvents({
          type: 'email.sent',
          data: { email_id: 'x', to: ['a@x.io'] },
        }),
      ).toEqual([]);
    });
  });
});
