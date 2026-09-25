/**
 * Shared vendor-HTTP plumbing — the classification rule every adapter
 * inherits, and the vendor-override hook Resend uses to correct it.
 */
import {
  MAX_RETRY_AFTER_MS,
  classifyResponse,
  classifyStatus,
  errorFromResponse,
  headerValue,
  maskEmail,
  parseRetryAfterMs,
  providerFetch,
  readErrorCode,
} from './provider-http.util';
import { EmailProviderError } from '../../identity/services/email-provider.interface';

describe('classifyStatus', () => {
  it.each([429, 408, 425, 500, 502, 503, 504, 599])('%i is transient', (status) => {
    expect(classifyStatus(status)).toBe('transient');
  });

  it.each([400, 401, 402, 403, 404, 405, 409, 410, 422, 451])(
    '%i is permanent by default',
    (status) => {
      expect(classifyStatus(status)).toBe('permanent');
    },
  );
});

describe('classifyResponse overrides', () => {
  const overrides = {
    transientCodes: ['concurrent_idempotent_requests'],
    permanentCodes: ['validation_error'],
    transientStatuses: [409],
  };

  it('lets a vendor code win over the status in both directions', () => {
    expect(classifyResponse(409, 'concurrent_idempotent_requests', overrides)).toBe(
      'transient',
    );
    expect(classifyResponse(500, 'validation_error', overrides)).toBe('permanent');
  });

  it('falls back to a vendor status list, then to the shared rule', () => {
    expect(classifyResponse(409, undefined, overrides)).toBe('transient');
    expect(classifyResponse(409, undefined)).toBe('permanent');
    expect(classifyResponse(503, undefined)).toBe('transient');
  });

  it('prefers the permanent list when a code somehow appears in both', () => {
    expect(
      classifyResponse(500, 'x', { transientCodes: ['x'], permanentCodes: ['x'] }),
    ).toBe('permanent');
  });
});

describe('parseRetryAfterMs', () => {
  it('reads delta-seconds and HTTP-dates, and ignores anything else', () => {
    expect(parseRetryAfterMs('7')).toBe(7000);
    expect(parseRetryAfterMs('  7 ')).toBe(7000);
    const now = Date.UTC(2026, 8, 25, 12, 0, 0);
    expect(parseRetryAfterMs(new Date(now + 5000).toUTCString(), now)).toBe(5000);
    // A date already in the past is "retry now", not a negative delay.
    expect(parseRetryAfterMs(new Date(now - 5000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });

  it('clamps a value large enough to park a message indefinitely', () => {
    expect(parseRetryAfterMs('99999999999')).toBe(MAX_RETRY_AFTER_MS);
    const now = Date.now();
    expect(parseRetryAfterMs(new Date(now + 40 * 86_400_000).toUTCString(), now)).toBe(
      MAX_RETRY_AFTER_MS,
    );
  });
});

describe('readErrorCode', () => {
  it('reads code, name or error, lower-cased and trimmed', async () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    await expect(readErrorCode(json({ code: 'Too_Many_Requests' }))).resolves.toBe(
      'too_many_requests',
    );
    await expect(readErrorCode(json({ name: ' validation_error ' }))).resolves.toBe(
      'validation_error',
    );
    await expect(readErrorCode(json({ error: 'not_found' }))).resolves.toBe('not_found');
    await expect(
      readErrorCode(json({ message: 'no code here' })),
    ).resolves.toBeUndefined();
    await expect(readErrorCode(json({ code: 42 }))).resolves.toBeUndefined();
    await expect(readErrorCode(json(null))).resolves.toBeUndefined();
    await expect(
      readErrorCode(new Response('<html>oops</html>', { status: 502 })),
    ).resolves.toBeUndefined();
  });
});

describe('errorFromResponse', () => {
  it('builds a PII-free error carrying status, kind, code and retry delay', async () => {
    const response = new Response(
      JSON.stringify({
        name: 'rate_limit_exceeded',
        message: 'Too many requests for learner@example.com',
      }),
      {
        status: 429,
        headers: { 'retry-after': '3', 'content-type': 'application/json' },
      },
    );
    const error = await errorFromResponse('resend', response);
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.kind).toBe('transient');
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(3000);
    expect(error.message).toBe('resend: HTTP 429 (rate_limit_exceeded)');
    expect(error.message).not.toContain('learner@example.com');
  });

  it('only reads a fallback retry header when Retry-After is absent', async () => {
    const withBoth = new Response('{}', {
      status: 429,
      headers: { 'retry-after': '3', 'ratelimit-reset': '90' },
    });
    await expect(
      errorFromResponse('resend', withBoth, { retryAfterHeaders: ['ratelimit-reset'] }),
    ).resolves.toMatchObject({ retryAfterMs: 3000 });

    const withFallbackOnly = new Response('{}', {
      status: 429,
      headers: { 'ratelimit-reset': '90' },
    });
    await expect(
      errorFromResponse('resend', withFallbackOnly, {
        retryAfterHeaders: ['ratelimit-reset'],
      }),
    ).resolves.toMatchObject({ retryAfterMs: 90_000 });
  });

  it('never attaches a retry delay to a permanent error', async () => {
    const response = new Response('{}', { status: 422, headers: { 'retry-after': '3' } });
    await expect(errorFromResponse('resend', response)).resolves.toMatchObject({
      kind: 'permanent',
      retryAfterMs: undefined,
    });
  });
});

describe('providerFetch', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('turns any network-level failure into a transient error without the request body', async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch;
    const error = (await providerFetch('resend', 'https://api.resend.com/emails', {
      method: 'POST',
      body: JSON.stringify({ to: 'learner@example.com' }),
    }).catch((e: unknown) => e)) as EmailProviderError;
    expect(error).toBeInstanceOf(EmailProviderError);
    expect(error.kind).toBe('transient');
    expect(error.message).not.toContain('learner@example.com');
  });

  it('aborts on the timeout and reports it transiently', async () => {
    global.fetch = jest.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    ) as unknown as typeof fetch;
    const error = (await providerFetch(
      'resend',
      'https://api.resend.com/emails',
      { method: 'POST' },
      5,
    ).catch((e: unknown) => e)) as EmailProviderError;
    expect(error.kind).toBe('transient');
    expect(error.message).toContain('AbortError');
  });
});

describe('headerValue and maskEmail', () => {
  it('finds a header whatever its casing and flattens arrays', () => {
    expect(headerValue({ 'Svix-Id': 'msg_1' }, 'svix-id')).toBe('msg_1');
    expect(headerValue({ 'svix-id': ['msg_1', 'msg_2'] }, 'Svix-Id')).toBe('msg_1');
    expect(headerValue({}, 'svix-id')).toBeUndefined();
  });

  it('never returns a whole address', () => {
    expect(maskEmail('learner@example.com')).toBe('l***@example.com');
    expect(maskEmail('not-an-address')).toBe('***');
  });
});
