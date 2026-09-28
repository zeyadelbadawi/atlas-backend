/**
 * Proves the exact P0 Definition of Done criterion from the master plan:
 * "an intentionally-thrown test exception returns a `NormalizedApiError`-
 * shaped body." No HTTP server, database, or Redis involved — this
 * exercises the filter directly against mocked Nest request/response
 * objects.
 */
import {
  ArgumentsHost,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { Logger } from 'nestjs-pino';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';
import type { NormalizedApiErrorResponse } from '../dto/api-error.dto';

function createMockHost(requestId: string) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const request = { requestId };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

function createMockLogger(): Logger {
  return { error: jest.fn(), warn: jest.fn(), log: jest.fn() } as unknown as Logger;
}

describe('AllExceptionsFilter', () => {
  it('shapes an arbitrary, unexpected Error as a NormalizedApiError with kind "server" and never leaks the raw message', () => {
    const logger = createMockLogger();
    const filter = new AllExceptionsFilter(logger);
    const { host, status, json } = createMockHost('req-1');

    filter.catch(new Error('a raw, possibly sensitive internal detail'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = json.mock.calls[0][0] as NormalizedApiErrorResponse;
    expect(body.error.kind).toBe('server');
    expect(body.error.requestId).toBe('req-1');
    expect(body.error.retryable).toBe(true);
    expect(body.error.messageKey).not.toContain('raw, possibly sensitive');
    expect(logger.error).toHaveBeenCalled();
  });

  it('answers input the database cannot represent (NUL byte, bad uuid) as a 400 validation failure, not a 500', () => {
    const cases = [
      new Prisma.PrismaClientUnknownRequestError(
        'Error occurred during query execution: PostgresError { code: "22021", message: "invalid byte sequence for encoding \\"UTF8\\": 0x00" }',
        { clientVersion: 'test' },
      ),
      new Prisma.PrismaClientKnownRequestError('Inconsistent column data: invalid uuid', {
        code: 'P2023',
        clientVersion: 'test',
      }),
    ];
    for (const exception of cases) {
      const logger = createMockLogger();
      const filter = new AllExceptionsFilter(logger);
      const { host, status, json } = createMockHost('req-db');
      filter.catch(exception, host);
      expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
      const body = json.mock.calls[0][0] as NormalizedApiErrorResponse;
      expect(body.error.messageKey).toBe('errors.validation.failed');
      expect(body.error.messageKey).not.toContain('0x00');
      expect(logger.error).not.toHaveBeenCalled();
    }
    // Any other database failure stays a 500.
    const logger = createMockLogger();
    const { host, status } = createMockHost('req-db2');
    new AllExceptionsFilter(logger).catch(
      new Prisma.PrismaClientUnknownRequestError('connection terminated', {
        clientVersion: 'test',
      }),
      host,
    );
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it("answers the body parser's refusals as the client's errors: too large 413, malformed JSON 400", () => {
    const tooLarge = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
      status: 413,
      expose: true,
    });
    const malformed = Object.assign(new Error('Unexpected token'), {
      type: 'entity.parse.failed',
      status: 400,
      expose: true,
    });
    for (const [exception, expected] of [
      [tooLarge, HttpStatus.PAYLOAD_TOO_LARGE],
      [malformed, HttpStatus.BAD_REQUEST],
    ] as const) {
      const { host, status } = createMockHost('req-body');
      new AllExceptionsFilter(createMockLogger()).catch(exception, host);
      expect(status).toHaveBeenCalledWith(expected);
    }
  });

  it('shapes a NotFoundException as kind "notFound", non-retryable', () => {
    const logger = createMockLogger();
    const filter = new AllExceptionsFilter(logger);
    const { host, status, json } = createMockHost('req-2');

    filter.catch(new NotFoundException(), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    const body = json.mock.calls[0][0] as NormalizedApiErrorResponse;
    expect(body.error.kind).toBe('notFound');
    expect(body.error.retryable).toBe(false);
    expect(body.error.status).toBe(HttpStatus.NOT_FOUND);
  });

  it("always includes the requesting call's requestId, never fabricating a different one", () => {
    const logger = createMockLogger();
    const filter = new AllExceptionsFilter(logger);
    const { host, json } = createMockHost('the-exact-request-id');

    filter.catch(new HttpException('forbidden', HttpStatus.FORBIDDEN), host);

    const body = json.mock.calls[0][0] as NormalizedApiErrorResponse;
    expect(body.error.requestId).toBe('the-exact-request-id');
  });
});
