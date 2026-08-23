/**
 * Maps an HTTP status code to the frontend's `ApiErrorKind` vocabulary.
 *
 * Kept as a small, pure, independently-testable function — the exception
 * filter's only job is to catch and shape a response; deciding *which*
 * kind a status maps to is a separate, unit-testable decision.
 */
import { HttpStatus } from '@nestjs/common';
import type { ApiErrorKind } from '../dto/api-error.dto';

const STATUS_TO_KIND: ReadonlyMap<number, ApiErrorKind> = new Map([
  [HttpStatus.REQUEST_TIMEOUT, 'timeout'],
  [HttpStatus.BAD_REQUEST, 'validation'],
  [HttpStatus.UNPROCESSABLE_ENTITY, 'validation'],
  [HttpStatus.UNAUTHORIZED, 'unauthorized'],
  [HttpStatus.FORBIDDEN, 'forbidden'],
  [HttpStatus.NOT_FOUND, 'notFound'],
  [HttpStatus.CONFLICT, 'conflict'],
  [HttpStatus.TOO_MANY_REQUESTS, 'rateLimited'],
]);

/** Whether a repeated identical request might succeed — never true for 4xx client errors, true for retryable infrastructure-shaped failures. */
const RETRYABLE_KINDS: ReadonlySet<ApiErrorKind> = new Set([
  'network',
  'timeout',
  'server',
]);

export function mapStatusToErrorKind(status: number): ApiErrorKind {
  const mapped = STATUS_TO_KIND.get(status);
  if (mapped) return mapped;
  if (status >= 500) return 'server';
  if (status >= 400) return 'unknown';
  return 'unknown';
}

export function isRetryableKind(kind: ApiErrorKind): boolean {
  return RETRYABLE_KINDS.has(kind);
}
