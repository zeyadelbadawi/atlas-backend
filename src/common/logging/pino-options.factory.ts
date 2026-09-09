/**
 * Structured logging configuration.
 *
 * Master plan §19 ("structured logging... never `console.log` free text in
 * production") and §16 ("logging redaction... passwords, tokens... redacted
 * from structured logs by default"). P0 has no auth/payment fields yet, but
 * the redaction list is established now so it's never forgotten once P1
 * introduces `password`/`token` fields — adding a field here is a one-line
 * change, not a retrofit.
 */
import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../../config/configuration';

interface RequestLike extends IncomingMessage {
  requestId?: string;
}

export function buildPinoOptions(app: AppConfig): Params {
  return {
    pinoHttp: {
      level: app.logLevel,
      // Human-readable output locally, real JSON lines everywhere else —
      // structured logging is the point in staging/production, where the
      // hosted log sink parses JSON, not a terminal.
      transport: app.isDevelopment
        ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
        : undefined,
      genReqId: (req: IncomingMessage) => (req as RequestLike).requestId ?? randomUUID(),
      // Phase 10 audited this list against the hard rule "never log
      // passwords, refresh tokens, access tokens, authorization headers or
      // secret environment variables", and closed three real gaps:
      //
      //  1. `*.token_hash` was snake_case only. Prisma returns JS objects
      //     with CAMELCASE fields, so a logged `RefreshToken` row (very
      //     much a Phase 10 code path) would have printed `tokenHash` in
      //     full. Both spellings are now covered, here and one level
      //     deeper, since these rows are usually logged nested inside a
      //     result object rather than at the top level.
      //  2. Response `set-cookie` was unredacted while request `cookie`
      //     was — the same secret, caught in only one direction.
      //  3. Token-bearing request/response bodies (`accessToken`,
      //     `refreshToken` on the way out) had no coverage.
      //
      // Secret environment variables are covered structurally rather than
      // by path: nothing logs `process.env`, and `configuration.ts` is
      // never serialised into a log line.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["proxy-authorization"]',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.confirmPassword',
          'req.body.token',
          'req.body.refreshToken',
          'req.body.accessToken',
          '*.password',
          '*.password_hash',
          '*.passwordHash',
          '*.token_hash',
          '*.tokenHash',
          '*.refreshToken',
          '*.accessToken',
          '*.*.password_hash',
          '*.*.passwordHash',
          '*.*.token_hash',
          '*.*.tokenHash',
          '*.*.refreshToken',
          '*.*.accessToken',
        ],
        censor: '[REDACTED]',
      },
      customSuccessMessage: (req: IncomingMessage, res: ServerResponse) =>
        `${req.method} ${req.url} -> ${res.statusCode}`,
      customErrorMessage: (req: IncomingMessage, res: ServerResponse) =>
        `${req.method} ${req.url} -> ${res.statusCode}`,
    },
  };
}
