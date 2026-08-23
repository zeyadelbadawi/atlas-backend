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
