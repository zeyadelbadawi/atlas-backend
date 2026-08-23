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
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.token',
          'req.body.refreshToken',
          '*.password_hash',
          '*.token_hash',
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
