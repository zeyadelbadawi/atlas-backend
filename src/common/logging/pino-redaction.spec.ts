/**
 * The production log redaction list, exercised through real pino: every
 * authentication secret Atlas handles is censored wherever a service might
 * log it (top level or one object deep).
 */
import pino from 'pino';
import { Writable } from 'node:stream';
import { buildPinoOptions } from './pino-options.factory';
import type { AppConfig } from '../../config/configuration';

function capture(obj: Record<string, unknown>): string {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += chunk.toString();
      cb();
    },
  });
  const options = buildPinoOptions({
    logLevel: 'info',
    isDevelopment: false,
  } as AppConfig).pinoHttp as { redact: pino.LoggerOptions['redact'] };
  pino({ redact: options.redact }, sink).info(obj, 'probe');
  return out;
}

const SECRET = 'S3CR3T-VALUE-THAT-MUST-NOT-APPEAR';

describe('log redaction (production list)', () => {
  it.each([
    ['refresh token in a response-like object', { result: { refreshToken: SECRET } }],
    ['access token at the root of the log object', { accessToken: SECRET }],
    ['refresh token at the root', { refreshToken: SECRET }],
    ['password hash at the root', { passwordHash: SECRET }],
    ['access token one level down', { session: { accessToken: SECRET } }],
    ['password hash (camel)', { user: { passwordHash: SECRET } }],
    ['password hash (snake)', { row: { password_hash: SECRET } }],
    ['token hash', { row: { tokenHash: SECRET } }],
    ['OAuth PKCE verifier', { flow: { codeVerifier: SECRET } }],
    ['OAuth nonce', { flow: { nonce: SECRET } }],
    [
      'TOTP otpauth URL',
      { enrolment: { otpauthUrl: `otpauth://totp/Atlas?secret=${SECRET}` } },
    ],
    ['recovery codes', { enrolment: { recoveryCodes: [SECRET] } }],
    [
      'request cookie',
      { req: { headers: { cookie: `__Host-atlas_session=${SECRET}` } } },
    ],
    [
      'response set-cookie',
      { res: { headers: { 'set-cookie': `__Host-atlas_session=${SECRET}` } } },
    ],
    ['authorization header', { req: { headers: { authorization: `Bearer ${SECRET}` } } }],
    ['body password', { req: { body: { password: SECRET } } }],
    ['body code', { req: { body: { code: SECRET } } }],
    ['body handoff', { req: { body: { handoff: SECRET } } }],
  ])('censors %s', (_label, obj) => {
    const line = capture(obj);
    expect(line).not.toContain(SECRET);
    expect(line).toContain('[REDACTED]');
  });
});
