/**
 * ResendEmailProvider — unit coverage against a mocked global `fetch` and
 * a fixed Svix secret.
 *
 * Every response body here is shaped like a real Resend response
 * (`{ id }` on success, `{ statusCode, name, message }` on failure). None
 * of this proves delivery: Atlas has no verified Resend sending domain,
 * so the live API has never accepted a message from this adapter.
 */
import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import {
  ResendEmailProvider,
  formatFromAddress,
  normalizeIdempotencyKey,
  toResendTags,
} from './resend-email.provider';
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

/** A ConfigService whose `email` namespace is missing entirely. */
const throwingConfig = {
  getOrThrow: () => {
    throw new Error('email config missing');
  },
} as unknown as ConfigService;

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

/** Resend's published error envelope. */
function errorResponse(
  status: number,
  name: string,
  headers: Record<string, string> = {},
) {
  return jsonResponse(
    status,
    { statusCode: status, name, message: 'human readable detail' },
    headers,
  );
}

function svixHeaders(
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
  id = 'msg_1',
  secret = RAW_SECRET,
) {
  const signature = createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${signature}`,
  } as Record<string, string>;
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

  /** Sends once and returns the `EmailProviderError` the adapter threw. */
  async function sendExpectingError(
    response: Response | Error,
    config = configWith(),
  ): Promise<EmailProviderError> {
    if (response instanceof Error) fetchMock.mockRejectedValueOnce(response);
    else fetchMock.mockResolvedValueOnce(response);
    return new ResendEmailProvider(config)
      .send({ to: 'a@example.com', subject: 's', text: 't' })
      .then(
        () => {
          throw new Error('expected the send to reject');
        },
        (error: unknown) => error as EmailProviderError,
      );
  }

  function lastRequest(): { url: string; init: RequestInit } {
    const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
      string,
      RequestInit,
    ];
    return { url, init };
  }

  it('declares Resend’s published free-tier capabilities', () => {
    expect(new ResendEmailProvider(configWith()).capabilities()).toEqual({
      dailyLimit: 100,
      monthlyLimit: 3000,
      perSecond: 2,
      supportsWebhooks: true,
      supportsHtml: true,
      supportsIdempotencyKey: true,
    });
  });

  // --- Request shape ------------------------------------------------------

  describe('request shape', () => {
    it('POSTs to the documented endpoint with Bearer auth and Idempotency-Key', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 'em_123' }));
      const result = await new ResendEmailProvider(configWith()).send({
        to: 'learner@example.com',
        subject: 'Hello',
        text: 'plain',
        html: '<p>plain</p>',
        idempotencyKey: 'outbox-1',
        replyTo: 'reply@example.com',
        headers: { 'X-Atlas-Outbox': 'outbox-1' },
      });
      expect(result).toEqual({ providerMessageId: 'em_123', provider: 'resend' });

      const { url, init } = lastRequest();
      expect(url).toBe('https://api.resend.com/emails');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer re_test');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Idempotency-Key']).toBe('outbox-1');
      expect(JSON.parse(init.body as string)).toEqual({
        from: 'Atlas <owner@example.com>',
        to: ['learner@example.com'],
        subject: 'Hello',
        text: 'plain',
        html: '<p>plain</p>',
        // `reply_to` is the REST field; the SDK-only `replyTo` alias is not
        // accepted on the wire.
        reply_to: 'reply@example.com',
        headers: { 'X-Atlas-Outbox': 'outbox-1' },
      });
    });

    it('falls back to EMAIL_REPLY_TO and omits optional fields that are unset', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 'em_1' }));
      await new ResendEmailProvider(configWith({ replyTo: 'support@example.com' })).send({
        to: 'a@example.com',
        subject: 's',
        text: 't',
      });
      const body = JSON.parse(lastRequest().init.body as string) as Record<
        string,
        unknown
      >;
      expect(body.reply_to).toBe('support@example.com');
      expect(body).not.toHaveProperty('html');
      expect(body).not.toHaveProperty('tags');
      expect(body).not.toHaveProperty('headers');
      expect(lastRequest().init.headers as Record<string, string>).not.toHaveProperty(
        'Idempotency-Key',
      );
    });

    it('accepts the legacy EMAIL_API_KEY when RESEND_API_KEY is unset', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 'em_1' }));
      await new ResendEmailProvider(
        configWith({ resendApiKey: undefined, apiKey: 're_legacy' }),
      ).send({ to: 'a@example.com', subject: 's', text: 't' });
      expect((lastRequest().init.headers as Record<string, string>).Authorization).toBe(
        'Bearer re_legacy',
      );
    });

    it('refuses permanently, without a network call, when the key or sender is missing', async () => {
      const provider = new ResendEmailProvider(
        configWith({ resendApiKey: undefined, apiKey: undefined }),
      );
      const error = (await provider
        .send({ to: 'a@example.com', subject: 's', text: 't' })
        .catch((e: unknown) => e)) as EmailProviderError;
      expect(error).toBeInstanceOf(EmailProviderError);
      expect(error.kind).toBe('permanent');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // --- `from` -------------------------------------------------------------

  describe('from address', () => {
    it('quotes a display name containing RFC 5322 specials', () => {
      expect(formatFromAddress('Atlas', 'a@b.io')).toBe('Atlas <a@b.io>');
      expect(formatFromAddress('Atlas, Inc.', 'a@b.io')).toBe('"Atlas, Inc." <a@b.io>');
      expect(formatFromAddress('He said "hi"', 'a@b.io')).toBe(
        '"He said \\"hi\\"" <a@b.io>',
      );
      expect(formatFromAddress(undefined, 'a@b.io')).toBe('a@b.io');
      expect(formatFromAddress('   ', 'a@b.io')).toBe('a@b.io');
    });

    it('sends the quoted form on the wire', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 'em_1' }));
      await new ResendEmailProvider(configWith({ fromName: 'Atlas, Inc.' })).send({
        to: 'a@example.com',
        subject: 's',
        text: 't',
      });
      expect(
        (JSON.parse(lastRequest().init.body as string) as { from: string }).from,
      ).toBe('"Atlas, Inc." <owner@example.com>');
    });
  });

  // --- Tags ---------------------------------------------------------------

  describe('tags', () => {
    it('splits Atlas’s key:value tags and sanitises both halves to Resend’s charset', () => {
      // This is exactly what `EmailTransport.flattenTags` produces today.
      expect(toResendTags(['key:course.order.paid', 'category:transactional'])).toEqual([
        { name: 'key', value: 'course_order_paid' },
        { name: 'category', value: 'transactional' },
      ]);
    });

    it('wraps a bare tag under the `atlas` name', () => {
      expect(toResendTags(['password_reset'])).toEqual([
        { name: 'atlas', value: 'password_reset' },
      ]);
    });

    it('de-duplicates repeated tag names and drops values that sanitise to nothing', () => {
      expect(toResendTags(['key:a', 'key:b', 'key:c'])).toEqual([
        { name: 'key', value: 'a' },
        { name: 'key_2', value: 'b' },
        { name: 'key_3', value: 'c' },
      ]);
      expect(toResendTags(['key:', 'key:...', '   '])).toBeUndefined();
      expect(toResendTags([])).toBeUndefined();
      expect(toResendTags(undefined)).toBeUndefined();
    });

    it('truncates to Resend’s 256-character ceiling', () => {
      const long = 'a'.repeat(400);
      const [tag] = toResendTags([`key:${long}`]) ?? [];
      expect(tag.value).toHaveLength(256);
    });

    it('puts only charset-legal pairs on the wire', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { id: 'em_1' }));
      await new ResendEmailProvider(configWith()).send({
        to: 'a@example.com',
        subject: 's',
        text: 't',
        tags: ['key:auth.password.reset', 'category:security'],
      });
      const { tags } = JSON.parse(lastRequest().init.body as string) as {
        tags: { name: string; value: string }[];
      };
      expect(tags).toEqual([
        { name: 'key', value: 'auth_password_reset' },
        { name: 'category', value: 'security' },
      ]);
      for (const tag of tags) {
        expect(tag.name).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(tag.value).toMatch(/^[A-Za-z0-9_-]+$/);
      }
    });
  });

  // --- Idempotency --------------------------------------------------------

  describe('idempotency key', () => {
    it('passes a normal key through, drops a blank one, and digests an over-long one', () => {
      expect(normalizeIdempotencyKey('  outbox-1  ')).toBe('outbox-1');
      expect(normalizeIdempotencyKey('')).toBeUndefined();
      expect(normalizeIdempotencyKey('   ')).toBeUndefined();
      expect(normalizeIdempotencyKey(undefined)).toBeUndefined();
      const long = 'x'.repeat(300);
      const digest = normalizeIdempotencyKey(long);
      expect(digest).toHaveLength(64);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      // Deterministic: the same logical send still collapses to one email.
      expect(normalizeIdempotencyKey(long)).toBe(digest);
      expect(normalizeIdempotencyKey('y'.repeat(300))).not.toBe(digest);
    });
  });

  // --- Success parsing ----------------------------------------------------

  describe('success responses', () => {
    it('reads the message id from the documented 200 body', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }),
      );
      await expect(
        new ResendEmailProvider(configWith()).send({
          to: 'a@example.com',
          subject: 's',
          text: 't',
        }),
      ).resolves.toEqual({
        providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794',
        provider: 'resend',
      });
    });

    it('still counts an accepted send whose body is unreadable, with a null id', async () => {
      for (const body of ['not json at all', JSON.stringify({ id: 42 }), '']) {
        fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
        await expect(
          new ResendEmailProvider(configWith()).send({
            to: 'a@example.com',
            subject: 's',
            text: 't',
          }),
        ).resolves.toEqual({ providerMessageId: null, provider: 'resend' });
      }
    });
  });

  // --- Error classification ----------------------------------------------

  describe('error classification', () => {
    it.each([
      [401, 'missing_api_key', 'permanent'],
      [403, 'invalid_api_key', 'permanent'],
      [403, 'invalid_from_address', 'permanent'],
      [404, 'not_found', 'permanent'],
      [405, 'method_not_allowed', 'permanent'],
      [400, 'invalid_idempotency_key', 'permanent'],
      [422, 'validation_error', 'permanent'],
      [422, 'missing_required_field', 'permanent'],
      [451, 'security_error', 'permanent'],
      [408, 'request_timeout', 'transient'],
      [409, 'concurrent_idempotent_requests', 'transient'],
      [425, 'too_early', 'transient'],
      [429, 'rate_limit_exceeded', 'transient'],
      [429, 'daily_quota_exceeded', 'transient'],
      [500, 'application_error', 'transient'],
      [500, 'internal_server_error', 'transient'],
      [502, 'bad_gateway', 'transient'],
      [503, 'service_unavailable', 'transient'],
    ])('HTTP %i %s → %s', async (status, name, kind) => {
      const error = await sendExpectingError(errorResponse(status, name));
      expect(error).toBeInstanceOf(EmailProviderError);
      expect(error.kind).toBe(kind);
      expect(error.status).toBe(status);
      expect(error.provider).toBe('resend');
      // The vendor code is surfaced for ops; nothing from `message` is.
      expect(error.message).toContain(name);
      expect(error.message).not.toContain('human readable detail');
    });

    it('honours Retry-After on 429', async () => {
      const error = await sendExpectingError(
        errorResponse(429, 'rate_limit_exceeded', { 'retry-after': '2' }),
      );
      expect(error.kind).toBe('transient');
      expect(error.retryAfterMs).toBe(2000);
    });

    it('falls back to Resend’s ratelimit-reset header when Retry-After is absent', async () => {
      const error = await sendExpectingError(
        errorResponse(429, 'daily_quota_exceeded', { 'ratelimit-reset': '30' }),
      );
      expect(error.kind).toBe('transient');
      expect(error.retryAfterMs).toBe(30_000);
    });

    it('clamps an absurd Retry-After instead of parking the message for years', async () => {
      const error = await sendExpectingError(
        errorResponse(429, 'rate_limit_exceeded', { 'retry-after': '99999999999' }),
      );
      expect(error.retryAfterMs).toBe(24 * 60 * 60 * 1000);
    });

    it('never attaches a retry delay to a permanent error', async () => {
      const error = await sendExpectingError(
        errorResponse(422, 'validation_error', { 'retry-after': '60' }),
      );
      expect(error.kind).toBe('permanent');
      expect(error.retryAfterMs).toBeUndefined();
    });

    it('lets a known-permanent code win over a 5xx status, so a bad request is never retried forever', async () => {
      const error = await sendExpectingError(errorResponse(500, 'validation_error'));
      expect(error.kind).toBe('permanent');
      expect(error.status).toBe(500);
    });

    it('lets a known-transient code win over a 4xx status', async () => {
      const error = await sendExpectingError(errorResponse(400, 'application_error'));
      expect(error.kind).toBe('transient');
    });

    it('classifies on the status alone when the error body is malformed or empty', async () => {
      const transient = await sendExpectingError(
        new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      );
      expect(transient.kind).toBe('transient');
      expect(transient.message).toBe('resend: HTTP 502');

      const permanent = await sendExpectingError(new Response('', { status: 422 }));
      expect(permanent.kind).toBe('permanent');
      expect(permanent.status).toBe(422);
    });

    it('treats a network failure and an aborted request as transient', async () => {
      const network = await sendExpectingError(new TypeError('fetch failed'));
      expect(network.kind).toBe('transient');
      expect(network.status).toBeUndefined();

      const abort = Object.assign(new Error('The operation was aborted.'), {
        name: 'AbortError',
      });
      const aborted = await sendExpectingError(abort);
      expect(aborted.kind).toBe('transient');
      // Never leaks the request body (recipient, subject, message text).
      expect(aborted.message).not.toContain('a@example.com');
    });
  });

  // --- Webhooks -----------------------------------------------------------

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
      expect(
        new ResendEmailProvider(configWith()).verifyWebhook(svixHeaders(body), body),
      ).toBe(true);
    });

    it('accepts the unbranded webhook-* header aliases Svix also sends', () => {
      const svix = svixHeaders(body);
      expect(
        new ResendEmailProvider(configWith()).verifyWebhook(
          {
            'webhook-id': svix['svix-id'],
            'webhook-timestamp': svix['svix-timestamp'],
            'webhook-signature': svix['svix-signature'],
          },
          body,
        ),
      ).toBe(true);
    });

    it('accepts one valid entry among several space-separated signatures (key rotation)', () => {
      const headers = svixHeaders(body);
      headers['svix-signature'] = `v1,AAAA ${headers['svix-signature']} v1,BBBB`;
      expect(new ResendEmailProvider(configWith()).verifyWebhook(headers, body)).toBe(
        true,
      );
    });

    it('rejects a tampered body', () => {
      const provider = new ResendEmailProvider(configWith());
      expect(provider.verifyWebhook(svixHeaders(body), `${body} `)).toBe(false);
      expect(
        provider.verifyWebhook(svixHeaders(body), body.replace('em_123', 'em_999')),
      ).toBe(false);
    });

    it('rejects a signature made with a different secret', () => {
      const other = Buffer.from('a-different-webhook-secret').toString('base64');
      expect(
        new ResendEmailProvider(configWith()).verifyWebhook(
          svixHeaders(body, Math.floor(Date.now() / 1000), 'msg_1', other),
          body,
        ),
      ).toBe(false);
    });

    it('rejects a replayed or future-dated timestamp outside the five-minute tolerance', () => {
      const provider = new ResendEmailProvider(configWith());
      const now = Math.floor(Date.now() / 1000);
      expect(provider.verifyWebhook(svixHeaders(body, now - 299), body)).toBe(true);
      expect(provider.verifyWebhook(svixHeaders(body, now - 301), body)).toBe(false);
      expect(provider.verifyWebhook(svixHeaders(body, now - 86_400), body)).toBe(false);
      expect(provider.verifyWebhook(svixHeaders(body, now + 301), body)).toBe(false);
    });

    it('rejects a timestamp that is not a plain integer', () => {
      const provider = new ResendEmailProvider(configWith());
      const now = Math.floor(Date.now() / 1000);
      for (const timestamp of [`${now}.0`, `1e${String(now).length}`, 'abc', '', '-1']) {
        const headers = svixHeaders(body, now);
        headers['svix-timestamp'] = timestamp;
        expect(provider.verifyWebhook(headers, body)).toBe(false);
      }
    });

    it('rejects missing headers and malformed signature entries', () => {
      const provider = new ResendEmailProvider(configWith());
      expect(provider.verifyWebhook({}, body)).toBe(false);
      for (const missing of ['svix-id', 'svix-timestamp', 'svix-signature']) {
        const headers = svixHeaders(body);
        delete headers[missing];
        expect(provider.verifyWebhook(headers, body)).toBe(false);
      }
      const headers = svixHeaders(body);
      headers['svix-signature'] = 'not-a-signature';
      expect(provider.verifyWebhook(headers, body)).toBe(false);
      headers['svix-signature'] = 'v1,!!!not-base64!!!';
      expect(provider.verifyWebhook(headers, body)).toBe(false);
      headers['svix-signature'] = 'v2,AAAA';
      expect(provider.verifyWebhook(headers, body)).toBe(false);
    });

    it('FAILS CLOSED when RESEND_WEBHOOK_SECRET is unset, blank or unreadable', () => {
      for (const secret of [undefined, '', 'whsec_']) {
        expect(
          new ResendEmailProvider(
            configWith({ resendWebhookSecret: secret }),
          ).verifyWebhook(svixHeaders(body), body),
        ).toBe(false);
      }
      // A config namespace that throws must not become a 500 on a public route.
      expect(
        new ResendEmailProvider(throwingConfig).verifyWebhook(svixHeaders(body), body),
      ).toBe(false);
    });
  });

  // --- Event parsing ------------------------------------------------------

  describe('parseWebhookEvents', () => {
    const provider = new ResendEmailProvider(configWith());

    it('maps a hard bounce, keeping the reason and the event time', () => {
      expect(
        provider.parseWebhookEvents({
          type: 'email.bounced',
          created_at: '2026-09-24T10:00:00.000Z',
          data: {
            email_id: 'em_123',
            to: ['bounced@example.com'],
            bounce: { type: 'Permanent', message: 'no such user' },
          },
        }),
      ).toEqual([
        {
          providerMessageId: 'em_123',
          recipientEmail: 'bounced@example.com',
          event: 'bounced',
          occurredAt: new Date('2026-09-24T10:00:00.000Z'),
          reason: 'no such user',
        },
      ]);
    });

    it.each([
      ['Transient', 'soft_bounced'],
      ['Undetermined', 'soft_bounced'],
      ['transient', 'soft_bounced'],
      ['Permanent', 'bounced'],
    ])(
      'a %s bounce is reported as %s, so only a real hard bounce can suppress an address',
      (bounceType, expected) => {
        expect(
          provider.parseWebhookEvents({
            type: 'email.bounced',
            data: { email_id: 'em_2', to: ['a@x.io'], bounce: { type: bounceType } },
          })[0].event,
        ).toBe(expected);
      },
    );

    it.each([
      ['email.delivered', 'delivered'],
      ['email.complained', 'complained'],
      ['email.opened', 'opened'],
      ['email.clicked', 'clicked'],
      ['email.delivery_delayed', 'soft_bounced'],
      ['email.failed', 'failed'],
    ])('maps %s to the shared %s vocabulary', (type, expected) => {
      expect(
        provider.parseWebhookEvents({ type, data: { email_id: 'x', to: ['a@x.io'] } })[0]
          .event,
      ).toBe(expected);
    });

    it('reads the failure reason from email.failed', () => {
      expect(
        provider.parseWebhookEvents({
          type: 'email.failed',
          data: { email_id: 'x', to: ['a@x.io'], failed: { reason: 'sender blocked' } },
        })[0].reason,
      ).toBe('sender blocked');
    });

    it('fans one event out over every recipient', () => {
      expect(
        provider
          .parseWebhookEvents({
            type: 'email.delivered',
            data: { email_id: 'x', to: ['a@x.io', 'b@x.io'] },
          })
          .map((event) => event.recipientEmail),
      ).toEqual(['a@x.io', 'b@x.io']);
    });

    it('drops events Atlas has no vocabulary for rather than guessing', () => {
      for (const type of ['email.sent', 'email.scheduled', 'contact.created', '']) {
        expect(
          provider.parseWebhookEvents({ type, data: { email_id: 'x', to: ['a@x.io'] } }),
        ).toEqual([]);
      }
    });

    it('rejects malformed payloads without throwing', () => {
      for (const payload of [
        null,
        undefined,
        '',
        'a string',
        42,
        [],
        [{ type: 'email.delivered', data: { email_id: 'x', to: ['a@x.io'] } }],
        {},
        { type: 'email.delivered' },
        { type: 'email.delivered', data: {} },
        { type: 'email.delivered', data: { email_id: 'x' } },
        { type: 'email.delivered', data: { email_id: 'x', to: [] } },
        { type: 'email.delivered', data: { email_id: 'x', to: [1, null] } },
        { type: 'email.delivered', data: { email_id: 42, to: ['a@x.io'] } },
        { type: 42, data: { email_id: 'x', to: ['a@x.io'] } },
      ]) {
        expect(provider.parseWebhookEvents(payload)).toEqual([]);
      }
    });

    it('falls back to now when created_at is missing or unparsable', () => {
      const before = Date.now();
      for (const created of [undefined, 'not a date', 12345]) {
        const [event] = provider.parseWebhookEvents({
          type: 'email.delivered',
          created_at: created,
          data: { email_id: 'x', to: ['a@x.io'] },
        });
        expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
      }
    });
  });
});
