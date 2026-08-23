/**
 * The normalized error contract.
 *
 * Mirrors the frontend's `NormalizedApiError`/`ApiErrorKind`/`FieldViolation`
 * (`src/types/api.types.ts` in the atlas frontend repo) field-for-field —
 * every error response this backend ever produces, from any endpoint, in
 * any later phase, must be shapeable into this type. This is the contract
 * the master plan's §10 ("Errors") and §21's P0 Definition of Done
 * ("an intentionally-thrown test exception returns a `NormalizedApiError`-
 * shaped body") both require.
 */

/**
 * Exactly the frontend's `API_ERROR_KINDS` union — do not add, remove, or
 * rename a value here without a corresponding, deliberate frontend change.
 */
export const API_ERROR_KINDS = [
  'network',
  'timeout',
  'cancelled',
  'validation',
  'unauthorized',
  'forbidden',
  'notFound',
  'conflict',
  'rateLimited',
  'server',
  'unknown',
] as const;

export type ApiErrorKind = (typeof API_ERROR_KINDS)[number];

export interface FieldViolation {
  readonly field: string;
  /** A stable, translation-key-shaped string (e.g. `"errors.course.slugTaken"`) — never literal English/Arabic text. */
  readonly messageKey: string;
  readonly values?: Record<string, string | number>;
}

export interface NormalizedApiError {
  readonly kind: ApiErrorKind;
  readonly messageKey: string;
  readonly code?: string;
  readonly status?: number;
  readonly violations?: readonly FieldViolation[];
  readonly requestId?: string;
  readonly retryable: boolean;
}

/** Every error response body is `{ error: NormalizedApiError }` — a stable envelope, not a bare error object, so future fields can be added alongside it without breaking existing consumers. */
export interface NormalizedApiErrorResponse {
  readonly error: NormalizedApiError;
}
