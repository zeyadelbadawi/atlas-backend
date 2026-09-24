/**
 * BrevoEmailProvider — unit coverage against a mocked global `fetch`.
 * No real key exists anywhere; nothing here may reach the network.
 */
import type { ConfigService } from '@nestjs/config';
import { BrevoEmailProvider } from './brevo-email.provider';
import {
  EmailProviderError,
  WEBHOOK_URL_SECRET_HEADER,
} from '../../identity/services/email-provider.interface';

const SECRET = 'brevo-shared-secret-0123456789';

function configWith(overrides: Record<string, unknown> = {}): ConfigService {
  return {
    getOrThrow: () => ({
      provider: 'brevo',
      providers: ['brevo'],
      brevoApiKey: 'xkeysib-test',
      fromEmail: 'owner@example.com',
      fromName: 'Atlas',
      brevoWebhookSecret: SECRET,
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

describe('BrevoEmailProvider', () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('declares the Brevo Free capabilities', () => {
    expect(new BrevoEmailProvider(configWith()).capabilities()).toEqual({
      dailyLimit: 300,
      monthlyLimit: 9000,
      perSecond: 5,
      supportsWebhooks: true,
      supportsHtml: true,
      supportsIdempotencyKey: false,
    });
  });

  it('POSTs the Brevo body shape with the api-key header and returns the messageId on 201', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(201, { messageId: '<abc@smtp-relay.mailin.fr>' }),
    );
    const provider = new BrevoEmailProvider(configWith({ replyTo: 'reply@example.com' }));

    const result = await provider.send({
      to: 'learner@example.com',
      subject: 'Hello',
      text: 'plain',
      html: '<p>plain</p>',
      headers: { 'X-Atlas': '1' },
      tags: ['transactional'],
    });

    expect(result).toEqual({
      providerMessageId: '<abc@smtp-relay.mailin.fr>',
      provider: 'brevo',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect((init.headers as Record<string, string>)['api-key']).toBe('xkeysib-test');
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { name: 'Atlas', email: 'owner@example.com' },
      to: [{ email: 'learner@example.com' }],
      subject: 'Hello',
      textContent: 'plain',
      htmlContent: '<p>plain</p>',
      replyTo: { email: 'reply@example.com' },
      headers: { 'X-Atlas': '1' },
      tags: ['transactional'],
    });
  });

  it('classifies 429 as transient and honours Retry-After', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(429, { code: 'too_many_requests' }, { 'retry-after': '7' }),
    );
    const provider = new BrevoEmailProvider(configWith());
    const error = await provider
      .send({ to: 'a@example.com', subject: 's', text: 't' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as EmailProviderError,
      );
    expect(error).toBeInstanceOf(EmailProviderError);
    expect((error as EmailProviderError).kind).toBe('transient');
    expect((error as EmailProviderError).status).toBe(429);
    expect((error as EmailProviderError).retryAfterMs).toBe(7000);
  });

  it('classifies 5xx as transient', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
    const error = await new BrevoEmailProvider(configWith())
      .send({ to: 'a@example.com', subject: 's', text: 't' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as EmailProviderError,
      );
    expect(error.kind).toBe('transient');
    expect(error.status).toBe(503);
  });

  it('classifies other 4xx as permanent and never echoes the recipient in the message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { code: 'invalid_parameter' }));
    const error = await new BrevoEmailProvider(configWith())
      .send({ to: 'secret-person@example.com', subject: 's', text: 't' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as EmailProviderError,
      );
    expect(error.kind).toBe('permanent');
    expect(error.status).toBe(400);
    expect(error.message).toContain('invalid_parameter');
    expect(error.message).not.toContain('secret-person');
  });

  it('turns a network failure into a transient error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const error = await new BrevoEmailProvider(configWith())
      .send({ to: 'a@example.com', subject: 's', text: 't' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as EmailProviderError,
      );
    expect(error.kind).toBe('transient');
  });

  it('refuses to send (permanent) without a key or sender', async () => {
    const error = await new BrevoEmailProvider(configWith({ brevoApiKey: undefined }))
      .send({ to: 'a@example.com', subject: 's', text: 't' })
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as EmailProviderError,
      );
    expect(error.kind).toBe('permanent');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('webhook', () => {
    const body = JSON.stringify({
      event: 'hard_bounce',
      email: 'bounced@example.com',
      'message-id': '<202309@smtp-relay.mailin.fr>',
      date: '2026-09-24 10:15:00',
      reason: 'mailbox does not exist',
    });

    it('accepts the URL secret and rejects a wrong or missing one', () => {
      const provider = new BrevoEmailProvider(configWith());
      expect(provider.verifyWebhook({ [WEBHOOK_URL_SECRET_HEADER]: SECRET }, body)).toBe(
        true,
      );
      expect(
        provider.verifyWebhook({ [WEBHOOK_URL_SECRET_HEADER]: `${SECRET}x` }, body),
      ).toBe(false);
      expect(provider.verifyWebhook({}, body)).toBe(false);
    });

    it('fails closed when no secret is configured', () => {
      const provider = new BrevoEmailProvider(
        configWith({ brevoWebhookSecret: undefined }),
      );
      expect(provider.verifyWebhook({ [WEBHOOK_URL_SECRET_HEADER]: SECRET }, body)).toBe(
        false,
      );
    });

    it('maps Brevo events onto the neutral vocabulary and parses date/ts_event', () => {
      const provider = new BrevoEmailProvider(configWith());
      const [event] = provider.parseWebhookEvents(JSON.parse(body));
      expect(event).toEqual({
        providerMessageId: '<202309@smtp-relay.mailin.fr>',
        recipientEmail: 'bounced@example.com',
        event: 'bounced',
        occurredAt: new Date('2026-09-24T10:15:00Z'),
        reason: 'mailbox does not exist',
      });

      const batch = provider.parseWebhookEvents([
        {
          event: 'delivered',
          email: 'a@x.io',
          'message-id': 'm1',
          ts_event: 1_700_000_000,
        },
        { event: 'soft_bounce', email: 'a@x.io', 'message-id': 'm1' },
        { event: 'spam', email: 'a@x.io', 'message-id': 'm1' },
        { event: 'opened', email: 'a@x.io', 'message-id': 'm1' },
        { event: 'click', email: 'a@x.io', 'message-id': 'm1' },
        { event: 'blocked', email: 'a@x.io', 'message-id': 'm1' },
        { event: 'invalid_email', email: 'a@x.io', 'message-id': 'm1' },
        { event: 'error', email: 'a@x.io', 'message-id': 'm1' },
        { event: 'request', email: 'a@x.io', 'message-id': 'm1' },
        { event: 'delivered', email: 'a@x.io' },
      ]);
      expect(batch.map((e) => e.event)).toEqual([
        'delivered',
        'soft_bounced',
        'complained',
        'opened',
        'clicked',
        'failed',
        'failed',
        'failed',
      ]);
      expect(batch[0].occurredAt).toEqual(new Date(1_700_000_000 * 1000));
    });
  });
});
