/**
 * B0-SEC-11 — every path that sets a password refuses common/breached
 * passwords, with the generic `validation:commonPassword` key; sign-in and
 * re-authentication are untouched.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { isCommonPassword } from './common-password.validator';
import { COMMON_PASSWORDS_TEXT } from './common-passwords.data';
import { RegisterDto } from '../dto/register.dto';
import { PasswordResetConfirmDto } from '../dto/password-reset-confirm.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { SignInDto } from '../dto/sign-in.dto';
import { classValidatorErrorsToViolations } from '../../common/validation/class-validator-violations.util';

const STRONG = 'correct-horse-battery';

async function violations(cls: new () => object, body: Record<string, unknown>) {
  return classValidatorErrorsToViolations(await validate(plainToInstance(cls, body)));
}

const register = (password: string) => ({
  name: 'Test User',
  email: 'user@example.com',
  password,
  phoneCountry: 'EG',
  phoneNumber: '01001234567',
});

describe('common password list', () => {
  it('holds only lower-case entries of 8+ characters, with no duplicates', () => {
    const entries = COMMON_PASSWORDS_TEXT.split('\n');
    expect(entries.length).toBeGreaterThan(40_000);
    expect(new Set(entries).size).toBe(entries.length);
    expect(entries.every((e) => e.length >= 8 && e === e.toLowerCase())).toBe(true);
  });

  it.each(['password123', '12345678', 'qwertyuiop', 'iloveyou1'])('lists %s', (p) => {
    expect(isCommonPassword(p)).toBe(true);
  });

  it('ignores case and surrounding spaces', () => {
    expect(isCommonPassword('Password123')).toBe(true);
    expect(isCommonPassword('  PASSWORD123 ')).toBe(true);
  });

  it('does not list an uncommon passphrase', () => {
    expect(isCommonPassword(STRONG)).toBe(false);
  });
});

describe.each([
  ['RegisterDto', RegisterDto, 'password', register],
  [
    'PasswordResetConfirmDto',
    PasswordResetConfirmDto,
    'newPassword',
    (p: string) => ({ token: 'reset-token', newPassword: p }),
  ],
  [
    'ChangePasswordDto',
    ChangePasswordDto,
    'newPassword',
    (p: string) => ({ currentPassword: 'whatever-it-was', newPassword: p }),
  ],
] as const)('%s', (_name, cls, field, body) => {
  it('refuses a common password with validation:commonPassword', async () => {
    expect(await violations(cls, body('Password123'))).toEqual([
      { field, messageKey: 'validation:commonPassword' },
    ]);
  });

  it('accepts an uncommon password', async () => {
    expect(await violations(cls, body(STRONG))).toEqual([]);
  });

  it('still reports a short password as too short only', async () => {
    expect(await violations(cls, body('abc'))).toEqual([
      { field, messageKey: 'validation:minLength', values: { count: 8 } },
    ]);
  });
});

describe('ChangePasswordDto current password', () => {
  it('does not apply the list to the current password', async () => {
    expect(
      await violations(ChangePasswordDto, {
        currentPassword: 'password123',
        newPassword: STRONG,
      }),
    ).toEqual([]);
  });
});

describe('SignInDto', () => {
  it('lets an existing common password sign in (the list only applies to new passwords)', async () => {
    const errors = await validate(
      plainToInstance(SignInDto, { email: 'user@example.com', password: 'password123' }),
    );
    expect(errors).toEqual([]);
  });
});
