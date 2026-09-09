/**
 * Proves the claim "no credential material is ever sent to Sentry".
 *
 * That claim is only as good as its evidence. Delivery to Sentry was
 * verified in production with a controlled event carrying deliberately
 * secret-shaped decoy fields; this suite is the repeatable half — it runs
 * the REAL `beforeSend` implementation over the same shapes and asserts
 * every decoy is censored, so a future edit that widens what leaves the
 * process fails here rather than in a hosted error report nobody reads.
 */
import { scrubEvent } from './sentry';
import type { ErrorEvent } from '@sentry/node';

const CENSOR = '[REDACTED]';

function eventWith(overrides: Partial<ErrorEvent>): ErrorEvent {
  return { event_id: 'test-event', ...overrides } as ErrorEvent;
}

describe('Sentry beforeSend scrubbing', () => {
  it('censors credential-bearing request headers but keeps diagnostic ones', () => {
    const scrubbed = scrubEvent(
      eventWith({
        request: {
          headers: {
            authorization: 'Bearer real-access-token',
            'proxy-authorization': 'Basic abc',
            cookie: 'session=real-session',
            'x-api-key': 'real-api-key',
            'user-agent': 'Mozilla/5.0',
            'content-type': 'application/json',
          },
        },
      }),
    );

    const headers = scrubbed.request?.headers as Record<string, string>;
    expect(headers.authorization).toBe(CENSOR);
    expect(headers['proxy-authorization']).toBe(CENSOR);
    expect(headers.cookie).toBe(CENSOR);
    expect(headers['x-api-key']).toBe(CENSOR);
    // Non-credential headers survive — scrubbing must not destroy the
    // context that makes an error report useful.
    expect(headers['user-agent']).toBe('Mozilla/5.0');
    expect(headers['content-type']).toBe('application/json');
  });

  it('censors credential keys in request bodies, at depth and inside arrays', () => {
    const scrubbed = scrubEvent(
      eventWith({
        request: {
          data: {
            email: 'user@example.com',
            password: 'real-password',
            newPassword: 'real-new-password',
            nested: {
              refreshToken: 'real-refresh-token',
              tokenHash: 'real-token-hash',
              safe: 'keep-me',
            },
            list: [{ accessToken: 'real-access-token' }],
          },
        },
      }),
    );

    const data = scrubbed.request?.data as Record<string, never>;
    expect(data.password).toBe(CENSOR);
    expect(data.newPassword).toBe(CENSOR);
    expect((data.nested as Record<string, string>).refreshToken).toBe(CENSOR);
    expect((data.nested as Record<string, string>).tokenHash).toBe(CENSOR);
    expect((data.nested as Record<string, string>).safe).toBe('keep-me');
    expect((data.list as unknown as Record<string, string>[])[0].accessToken).toBe(
      CENSOR,
    );
    // Email is deliberately NOT censored: it is the field that makes a
    // production error attributable to a real report, and it is not a
    // credential.
    expect(data.email).toBe('user@example.com');
  });

  it('drops cookies and query strings wholesale rather than filtering them', () => {
    const scrubbed = scrubEvent(
      eventWith({
        request: {
          cookies: { session: 'real-session' },
          query_string: 'token=real-token-in-an-unexpected-place',
          url: 'https://atlass.dpdns.org/api/v1/auth/sessions',
        },
      }),
    );

    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.query_string).toBeUndefined();
    // The URL itself is kept — it is the single most useful field for
    // locating a fault, and this codebase never puts secrets in a path.
    expect(scrubbed.request?.url).toBe('https://atlass.dpdns.org/api/v1/auth/sessions');
  });

  it('censors the exact decoy payload used for the production verification event', () => {
    // The same shapes sent from the production container during the
    // Phase 10.1 verification, so this test and that event correspond
    // one-to-one.
    const scrubbed = scrubEvent(
      eventWith({
        extra: {
          password: 'DECOY-PASSWORD-SHOULD-BE-REDACTED',
          accessToken: 'DECOY-ACCESS-TOKEN-SHOULD-BE-REDACTED',
          refreshToken: 'DECOY-REFRESH-TOKEN-SHOULD-BE-REDACTED',
          tokenHash: 'DECOY-TOKEN-HASH-SHOULD-BE-REDACTED',
          harmlessContext: 'atlas-phase-10-1-verification',
        },
      }),
    );

    const extra = scrubbed.extra as Record<string, string>;
    expect(extra.password).toBe(CENSOR);
    expect(extra.accessToken).toBe(CENSOR);
    expect(extra.refreshToken).toBe(CENSOR);
    expect(extra.tokenHash).toBe(CENSOR);
    expect(extra.harmlessContext).toBe('atlas-phase-10-1-verification');

    // Belt and braces: no decoy value survives anywhere in the serialised
    // event, regardless of which key it sat under.
    expect(JSON.stringify(scrubbed)).not.toContain('DECOY-PASSWORD');
    expect(JSON.stringify(scrubbed)).not.toContain('DECOY-ACCESS-TOKEN');
    expect(JSON.stringify(scrubbed)).not.toContain('DECOY-REFRESH-TOKEN');
    expect(JSON.stringify(scrubbed)).not.toContain('DECOY-TOKEN-HASH');
  });

  it('terminates on deeply nested and cyclic payloads instead of hanging', () => {
    // A `beforeSend` that threw or hung would take down error reporting
    // entirely — the one path that must stay reliable when everything
    // else is already failing.
    const cyclic: Record<string, unknown> = { password: 'real-password' };
    cyclic.self = cyclic;

    expect(() => scrubEvent(eventWith({ extra: { cyclic } }))).not.toThrow();
  });
});
