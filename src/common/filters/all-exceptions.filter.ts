/**
 * Global exception filter.
 *
 * The single place every uncaught error in the app is turned into a
 * `NormalizedApiError`-shaped response (master plan §10 "Errors", §21 P0
 * Definition of Done). No controller, service, or later-phase module should
 * ever hand-construct an error response body itself — throw a NestJS
 * `HttpException` (or a plain `Error` for anything unexpected) and let this
 * filter do the shaping, so the contract can never drift between endpoints.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Logger } from 'nestjs-pino';
import type { FieldViolation, NormalizedApiErrorResponse } from '../dto/api-error.dto';
import { isRetryableKind, mapStatusToErrorKind } from './error-kind.util';

/** Shape NestJS's built-in `ValidationPipe` produces for a failed `class-validator` check. */
interface ValidationExceptionResponse {
  readonly message: string[] | string;
  readonly error?: string;
  readonly statusCode?: number;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = request.requestId;

    const { status, messageKey, code, violations } = this.resolve(exception);
    const kind = mapStatusToErrorKind(status);

    const body: NormalizedApiErrorResponse = {
      error: {
        kind,
        messageKey,
        code,
        status,
        violations,
        requestId,
        retryable: isRetryableKind(kind),
      },
    };

    if (status >= 500) {
      this.logger.error(
        { requestId, status, exception: this.describe(exception) },
        'Unhandled exception',
      );
    } else {
      this.logger.warn({ requestId, status, messageKey }, 'Request failed');
    }

    response.status(status).json(body);
  }

  private resolve(exception: unknown): {
    status: number;
    messageKey: string;
    code?: string;
    violations?: readonly FieldViolation[];
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();

      if (status === HttpStatus.BAD_REQUEST && this.isValidationResponse(payload)) {
        return {
          status,
          messageKey: 'errors.validation.failed',
          violations: this.toViolations(payload.message),
        };
      }

      if (typeof payload === 'string') {
        return { status, messageKey: this.toMessageKey(status, payload) };
      }

      // A handler-supplied `{ messageKey, code?, violations? }` payload
      // (e.g. `new UnauthorizedException({ messageKey:
      // 'errors.auth.invalidCredentials' })`, first needed by Phase P1 to
      // distinguish business-error cases that share one HTTP status —
      // invalid credentials vs. a suspended account are both 401/403 but
      // must not collapse to the same generic message) always wins over
      // the generic per-status default. Exceptions that don't supply one
      // (e.g. a plain `new NotFoundException()`) fall through unchanged to
      // the existing generic lookup below — this is additive, not a
      // behavior change for P0's own usage.
      if (this.hasCustomMessageKey(payload)) {
        return {
          status,
          messageKey: payload.messageKey,
          code: payload.code,
          violations: payload.violations,
        };
      }

      return { status, messageKey: this.toMessageKey(status, exception.message) };
    }

    // Anything that isn't a deliberate HttpException is an unexpected,
    // unhandled failure — never leak its raw message to the client (it may
    // contain internals/stack detail); the full detail is still logged above.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      messageKey: 'errors.server.unexpected',
    };
  }

  private hasCustomMessageKey(payload: unknown): payload is {
    messageKey: string;
    code?: string;
    violations?: readonly FieldViolation[];
  } {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'messageKey' in payload &&
      typeof (payload as { messageKey: unknown }).messageKey === 'string'
    );
  }

  private isValidationResponse(payload: unknown): payload is ValidationExceptionResponse {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      'message' in payload &&
      Array.isArray((payload as ValidationExceptionResponse).message)
    );
  }

  private toViolations(messages: string[] | string): readonly FieldViolation[] {
    const list = Array.isArray(messages) ? messages : [messages];
    // class-validator messages aren't field-structured out of the box in
    // this generic form — later phases with real DTOs should throw a typed
    // validation exception carrying real `FieldViolation[]` instead of
    // relying on this best-effort fallback parse.
    return list.map((message) => ({
      field: 'unknown',
      messageKey: 'errors.validation.field',
      values: { message },
    }));
  }

  private toMessageKey(status: number, fallback: string): string {
    const knownKeys: Partial<Record<number, string>> = {
      [HttpStatus.NOT_FOUND]: 'errors.notFound',
      [HttpStatus.UNAUTHORIZED]: 'errors.unauthorized',
      [HttpStatus.FORBIDDEN]: 'errors.forbidden',
      [HttpStatus.CONFLICT]: 'errors.conflict',
      [HttpStatus.TOO_MANY_REQUESTS]: 'errors.rateLimited',
    };
    return knownKeys[status] ?? fallback ?? 'errors.unknown';
  }

  private describe(exception: unknown): string {
    if (exception instanceof Error) return exception.stack ?? exception.message;
    return String(exception);
  }
}
