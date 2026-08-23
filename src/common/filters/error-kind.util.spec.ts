import { HttpStatus } from '@nestjs/common';
import { isRetryableKind, mapStatusToErrorKind } from './error-kind.util';

describe('mapStatusToErrorKind', () => {
  it.each([
    [HttpStatus.BAD_REQUEST, 'validation'],
    [HttpStatus.UNPROCESSABLE_ENTITY, 'validation'],
    [HttpStatus.UNAUTHORIZED, 'unauthorized'],
    [HttpStatus.FORBIDDEN, 'forbidden'],
    [HttpStatus.NOT_FOUND, 'notFound'],
    [HttpStatus.CONFLICT, 'conflict'],
    [HttpStatus.TOO_MANY_REQUESTS, 'rateLimited'],
    [HttpStatus.REQUEST_TIMEOUT, 'timeout'],
  ] as const)('maps HTTP %i to "%s"', (status, expected) => {
    expect(mapStatusToErrorKind(status)).toBe(expected);
  });

  it('maps any unmapped 5xx status to "server"', () => {
    expect(mapStatusToErrorKind(HttpStatus.INTERNAL_SERVER_ERROR)).toBe('server');
    expect(mapStatusToErrorKind(HttpStatus.BAD_GATEWAY)).toBe('server');
    expect(mapStatusToErrorKind(599)).toBe('server');
  });

  it('maps any unmapped 4xx status to "unknown" rather than guessing', () => {
    expect(mapStatusToErrorKind(HttpStatus.I_AM_A_TEAPOT)).toBe('unknown');
  });
});

describe('isRetryableKind', () => {
  it('treats network/timeout/server failures as retryable', () => {
    expect(isRetryableKind('network')).toBe(true);
    expect(isRetryableKind('timeout')).toBe(true);
    expect(isRetryableKind('server')).toBe(true);
  });

  it('never treats a client-caused failure as retryable', () => {
    expect(isRetryableKind('validation')).toBe(false);
    expect(isRetryableKind('unauthorized')).toBe(false);
    expect(isRetryableKind('forbidden')).toBe(false);
    expect(isRetryableKind('notFound')).toBe(false);
    expect(isRetryableKind('conflict')).toBe(false);
  });
});
