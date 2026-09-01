/**
 * class-validator → `NormalizedApiError` bridge.
 *
 * The global `ValidationPipe` (`main.ts`) validates every DTO in this
 * codebase with `class-validator`. Until now it used Nest's default
 * behavior, which collapses every failing constraint into a flat
 * `message: string[]` of pre-rendered English sentences with the field
 * name discarded — `AllExceptionsFilter.toViolations` could only ever
 * report `field: 'unknown'` for these, exactly the gap its own doc
 * comment names: "later phases with real DTOs should throw a typed
 * validation exception carrying real `FieldViolation[]` instead of
 * relying on this best-effort fallback parse." `zod-violations.util.ts`
 * already built this bridge for the website/billing modules' Zod
 * payloads; this is the same bridge for every ordinary class-validator
 * DTO, reusing the identical `'validation:*'` frontend translation keys
 * (`atlas-front/src/localization/resources/{en,ar}/validation.json`) rather
 * than inventing parallel ones.
 *
 * Wired as the global `ValidationPipe`'s `exceptionFactory` (`main.ts`),
 * so every controller across the app gets real per-field violations for
 * free — no per-DTO or per-controller change required.
 */
import { BadRequestException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import type { FieldViolation } from '../dto/api-error.dto';

/**
 * Maps a `class-validator` constraint name (the key class-validator itself
 * uses on `ValidationError.constraints`) to the frontend's existing
 * `validation:*` key. Scoped to exactly the decorators actually used
 * across this backend's DTOs (confirmed by grep) — not a speculative
 * exhaustive list of every decorator class-validator ships.
 */
const CONSTRAINT_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  isNotEmpty: 'validation:required',
  isDefined: 'validation:required',
  isEmail: 'validation:invalidEmail',
  isUrl: 'validation:invalidUrl',
  minLength: 'validation:minLength',
  maxLength: 'validation:maxLength',
  min: 'validation:min',
  max: 'validation:max',
  isPositive: 'validation:min',
  matches: 'validation:pattern',
  isInt: 'validation:integer',
  isNumber: 'validation:number',
};

/** Generic fallback for constraints with no closer match (`isString`, `isBoolean`, `isIn`, `isArray`, `isObject`, `isBooleanString`, ...) — these almost always indicate a malformed request rather than a user typo, so a plain "not valid" reads correctly. */
const FALLBACK_MESSAGE_KEY = 'validation:invalid';

/**
 * class-validator's default constraint messages always embed the exact
 * configured threshold as the only number in the sentence (e.g. `"name
 * must be longer than or equal to 2 characters"`, `"age must not be less
 * than 18"`) — this is stable, documented default-message behavior, not a
 * guess. Extracting it lets `{{count}}`/`{{min}}`/`{{max}}` interpolate
 * correctly on the frontend without hand-maintaining a second copy of
 * every decorator's configured value here.
 */
function extractThreshold(message: string): number | undefined {
  const match = /(\d+)/.exec(message);
  return match ? Number(match[1]) : undefined;
}

function violationForConstraint(
  field: string,
  constraintKey: string,
  defaultMessage: string,
): FieldViolation {
  const messageKey = CONSTRAINT_MESSAGE_KEYS[constraintKey] ?? FALLBACK_MESSAGE_KEY;
  const threshold = extractThreshold(defaultMessage);

  if (threshold === undefined) {
    return { field, messageKey };
  }

  if (messageKey === 'validation:minLength' || messageKey === 'validation:maxLength') {
    return { field, messageKey, values: { count: threshold } };
  }
  if (messageKey === 'validation:min' || messageKey === 'validation:max') {
    return {
      field,
      messageKey,
      values: { [messageKey === 'validation:min' ? 'min' : 'max']: threshold },
    };
  }

  return { field, messageKey };
}

/**
 * Flattens `class-validator`'s `ValidationError[]` (including nested
 * `children`, dot-joined into the parent's property path — the same
 * `.`-joined convention `zodIssuesToViolations` already uses) into real,
 * field-attributed violations. One violation per failing constraint per
 * field (a field with two failing rules reports both — the frontend form
 * only ever renders the last one `setError` receives, matching how a
 * single Zod schema would also report only its first failing check per
 * field today).
 */
export function classValidatorErrorsToViolations(
  errors: readonly ValidationError[],
  parentPath = '',
): FieldViolation[] {
  const violations: FieldViolation[] = [];

  for (const error of errors) {
    const field = parentPath ? `${parentPath}.${error.property}` : error.property;

    if (error.constraints) {
      for (const [constraintKey, defaultMessage] of Object.entries(error.constraints)) {
        violations.push(violationForConstraint(field, constraintKey, defaultMessage));
      }
    }

    if (error.children && error.children.length > 0) {
      violations.push(...classValidatorErrorsToViolations(error.children, field));
    }
  }

  return violations;
}

/** Throws a `BadRequestException` shaped exactly like every other explicit validation failure in this codebase — the shape `AllExceptionsFilter.hasCustomMessageKey` already passes through untouched. */
export function throwClassValidatorViolations(errors: readonly ValidationError[]): never {
  throw new BadRequestException({
    messageKey: 'errors.validation.failed',
    violations: classValidatorErrorsToViolations(errors),
  });
}
