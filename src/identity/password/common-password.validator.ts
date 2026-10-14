/**
 * B0-SEC-11 — refuses a new password that appears on a list of commonly
 * used passwords. Checked locally against a bundled list: no network call,
 * nothing about the password leaves the process.
 *
 * Applied to every path that SETS a password (register, password reset,
 * change password) — never to sign-in or re-authentication, where an
 * existing password must keep working. The comparison ignores case and
 * surrounding spaces, so "Password123" and " password123 " are refused too.
 */
import { registerDecorator, type ValidationOptions } from 'class-validator';
import { COMMON_PASSWORDS_TEXT } from './common-passwords.data';

/** Constraint name, mapped to `validation:commonPassword` in `class-validator-violations.util.ts`. */
export const COMMON_PASSWORD_CONSTRAINT = 'isNotCommonPassword';

let commonPasswords: ReadonlySet<string> | undefined;

function list(): ReadonlySet<string> {
  commonPasswords ??= new Set(COMMON_PASSWORDS_TEXT.split('\n'));
  return commonPasswords;
}

export function isCommonPassword(value: string): boolean {
  return list().has(value.trim().toLowerCase());
}

export function IsNotCommonPassword(options?: ValidationOptions) {
  return (target: object, propertyName: string): void => {
    registerDecorator({
      name: COMMON_PASSWORD_CONSTRAINT,
      target: target.constructor,
      propertyName,
      options: { message: 'password is too common', ...options },
      validator: {
        // A non-string is the `@IsString()` rule's violation, not this one.
        validate: (value: unknown): boolean =>
          typeof value !== 'string' || !isCommonPassword(value),
      },
    });
  };
}
