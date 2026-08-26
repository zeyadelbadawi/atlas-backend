/**
 * Zod → `NormalizedApiError` bridge.
 *
 * `AllExceptionsFilter` already documents the intended pattern for later
 * phases: "throw a typed validation exception carrying real
 * `FieldViolation[]` instead of relying on [the class-validator] best-effort
 * fallback parse." Introduced in P9/P10 (`src/website/validation/`) for
 * Website payloads validated with Zod (section configs, brand/seo/
 * navigation/header/footer, page SEO) — the exact same schemas the
 * frontend's own `website-section.schemas.ts`/`website.schemas.ts` already
 * enforce client-side, reused here so a `field`/`messageKey` pair is always
 * structured, never a generic string. Moved to `common/` in P12 when
 * `src/billing/` needed the identical bridge for `CheckoutTarget`'s
 * discriminated union — same "one shared definition, not near-identical
 * copies" reasoning `common/dto/collection-query.dto.ts`'s own P3→P5 move
 * already established in this codebase; the Website module's own imports
 * were updated to this new path, nothing about their behavior changed.
 *
 * `issue.message` is deliberately the same `"validation:*"` translation
 * key string the frontend's Zod schemas already pass as each check's
 * `message` argument (e.g. `z.string().min(1, 'validation:required')`) —
 * reusing the frontend's own real i18n keys, not inventing parallel ones,
 * for every violation shape the frontend already has a key for.
 */
import { BadRequestException } from '@nestjs/common';
import type { ZodError, ZodIssue } from 'zod';
import type { FieldViolation } from '../dto/api-error.dto';

export function zodIssuesToViolations(issues: readonly ZodIssue[]): FieldViolation[] {
  return issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : 'root',
    messageKey: issue.message,
  }));
}

/** Throws a `BadRequestException` shaped exactly like every other explicit validation failure in this codebase. */
export function throwZodValidation(error: ZodError): never {
  throw new BadRequestException({
    messageKey: 'errors.validation.failed',
    violations: zodIssuesToViolations(error.issues),
  });
}

/** Parses `value` against `schema`, throwing a structured `BadRequestException` on failure. */
export function parseOrThrow<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: ZodError } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throwZodValidation(result.error as ZodError);
  }
  return result.data as T;
}
