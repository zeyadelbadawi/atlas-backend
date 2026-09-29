import { redactQueryObject, redactUrlQuery } from './sensitive-query.util';
import { buildPinoOptions } from './pino-options.factory';
import type { AppConfig } from '../../config/configuration';

describe('sensitive query redaction', () => {
  it('censors an OAuth callback code and state, keeping the rest', () => {
    expect(
      redactUrlQuery('/api/v1/auth/google/callback?code=4/abc&state=xyz&scope=email'),
    ).toBe('/api/v1/auth/google/callback?code=[REDACTED]&state=[REDACTED]&scope=email');
  });

  it('leaves URLs without sensitive parameters untouched', () => {
    expect(redactUrlQuery('/api/v1/courses?page=2&sort=name')).toBe(
      '/api/v1/courses?page=2&sort=name',
    );
    expect(redactUrlQuery('/health')).toBe('/health');
    expect(redactUrlQuery(undefined)).toBeUndefined();
  });

  it('censors token-like parameters by name', () => {
    expect(redactUrlQuery('/x?token=t&id_token=i&access_token=a&refresh_token=r')).toBe(
      '/x?token=[REDACTED]&id_token=[REDACTED]&access_token=[REDACTED]&refresh_token=[REDACTED]',
    );
  });

  it('censors a webhook secret carried in the URL (Brevo ?secret=)', () => {
    expect(redactUrlQuery('/api/v1/webhooks/email/brevo?secret=s3cr3t-value')).toBe(
      '/api/v1/webhooks/email/brevo?secret=[REDACTED]',
    );
    expect(redactQueryObject({ secret: 's3cr3t-value' })).toEqual({
      secret: '[REDACTED]',
    });
    expect(redactUrlQuery('/x?api_key=a&key=k&sig=s&signature=g&password=p')).toBe(
      '/x?api_key=[REDACTED]&key=[REDACTED]&sig=[REDACTED]&signature=[REDACTED]&password=[REDACTED]',
    );
  });

  it('censors the parsed query object without mutating it', () => {
    const query = { code: 'secret', state: 's', error: 'access_denied' };
    expect(redactQueryObject(query)).toEqual({
      code: '[REDACTED]',
      state: '[REDACTED]',
      error: 'access_denied',
    });
    expect(query.code).toBe('secret');
  });

  it('is wired into the request logger: serializer and message lines', () => {
    const options = buildPinoOptions({
      logLevel: 'info',
      isDevelopment: false,
    } as AppConfig);
    const http = options.pinoHttp as {
      serializers: { req: (req: Record<string, unknown>) => Record<string, unknown> };
      customSuccessMessage: (
        req: { method: string; url: string },
        res: { statusCode: number },
      ) => string;
    };
    const serialized = http.serializers.req({
      method: 'GET',
      url: '/api/v1/auth/google/callback?code=c0de&state=st4te',
      query: { code: 'c0de', state: 'st4te' },
    });
    expect(JSON.stringify(serialized)).not.toMatch(/c0de|st4te/);
    const message = http.customSuccessMessage(
      { method: 'GET', url: '/api/v1/auth/google/callback?code=c0de&state=st4te' },
      { statusCode: 303 },
    );
    expect(message).not.toMatch(/c0de|st4te/);
  });
});
