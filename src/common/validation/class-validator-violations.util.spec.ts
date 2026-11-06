import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsIntInRange, withViolation } from './violation-message';
import { Type } from 'class-transformer';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException } from '@nestjs/common';
import {
  classValidatorErrorsToViolations,
  throwClassValidatorViolations,
} from './class-validator-violations.util';

class AddressDto {
  @IsNotEmpty()
  @IsString()
  readonly country!: string;
}

class SampleDto {
  @IsNotEmpty()
  @IsEmail()
  readonly email!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  readonly name?: string;

  @ValidateNested()
  @Type(() => AddressDto)
  readonly address!: AddressDto;
}

function validate(plain: Record<string, unknown>) {
  const instance = plainToInstance(SampleDto, plain);
  return validateSync(instance);
}

describe('classValidatorErrorsToViolations', () => {
  it('reports the real failing field, not "unknown"', () => {
    const errors = validate({ email: 'not-an-email', address: { country: 'EG' } });
    const violations = classValidatorErrorsToViolations(errors);

    expect(violations).toContainEqual({
      field: 'email',
      messageKey: 'validation:invalidEmail',
    });
  });

  it('reproduces the exact reported bug: a too-short name maps to a real minLength violation on "name"', () => {
    const errors = validate({
      email: 'owner@example.com',
      name: 'a',
      address: { country: 'EG' },
    });
    const violations = classValidatorErrorsToViolations(errors);

    expect(violations).toContainEqual({
      field: 'name',
      messageKey: 'validation:minLength',
      values: { count: 2 },
    });
  });

  it('dot-joins nested validation errors into the parent path, matching the Zod bridge convention', () => {
    const errors = validate({ email: 'owner@example.com', address: { country: '' } });
    const violations = classValidatorErrorsToViolations(errors);

    expect(violations).toContainEqual({
      field: 'address.country',
      messageKey: 'validation:required',
    });
  });

  it('reports every failing field when several fail at once', () => {
    const errors = validate({
      email: 'not-an-email',
      name: 'a',
      address: { country: '' },
    });
    const violations = classValidatorErrorsToViolations(errors);
    const fields = violations.map((v) => v.field).sort();

    expect(fields).toEqual(['address.country', 'email', 'name']);
  });
});

/** B8 (UX audit) — constraints that name their own violation through `context`. */
class NamedDto {
  @IsOptional()
  @Matches(/^[A-Z]{2}\d{2}/, withViolation('validation:invalidIban'))
  readonly iban?: string;

  @IsOptional()
  @IsIntInRange(1, 365)
  readonly days?: number;

  @IsOptional()
  @IsIntInRange(0, 10000, 'errors.commission.percentageRange', { min: 0, max: 100 })
  readonly basisPoints?: number;

  @IsOptional()
  @MinLength(10, withViolation('errors.reasonTooShort', { count: 10 }))
  readonly reason?: string;
}

describe('classValidatorErrorsToViolations — named violations (context)', () => {
  const violationsFor = (plain: Record<string, unknown>) =>
    classValidatorErrorsToViolations(validateSync(plainToInstance(NamedDto, plain)));

  it('forwards the format key a constraint names instead of the generic pattern key', () => {
    expect(violationsFor({ iban: 'nope' })).toEqual([
      { field: 'iban', messageKey: 'validation:invalidIban' },
    ]);
  });

  it.each([-3, 0, 2.5, 366, 1000, 'abc', null])(
    'reports ONE range violation with both ends for %p',
    (days) => {
      expect(violationsFor({ days })).toEqual(
        days === null
          ? []
          : [
              {
                field: 'days',
                messageKey: 'validation:integerRange',
                values: { min: 1, max: 365 },
              },
            ],
      );
    },
  );

  it('accepts both ends of the range', () => {
    expect(violationsFor({ days: 1 })).toEqual([]);
    expect(violationsFor({ days: 365 })).toEqual([]);
  });

  it('carries the values the constraint names, not its own thresholds', () => {
    expect(violationsFor({ basisPoints: -500 })).toEqual([
      {
        field: 'basisPoints',
        messageKey: 'errors.commission.percentageRange',
        values: { min: 0, max: 100 },
      },
    ]);
    expect(violationsFor({ reason: 'short' })).toEqual([
      { field: 'reason', messageKey: 'errors.reasonTooShort', values: { count: 10 } },
    ]);
  });

  it('leaves constraints without a named violation exactly as before', () => {
    const errors = validate({
      email: 'owner@example.com',
      name: 'a',
      address: { country: 'EG' },
    });
    expect(classValidatorErrorsToViolations(errors)).toEqual([
      { field: 'name', messageKey: 'validation:minLength', values: { count: 2 } },
    ]);
  });
});

describe('throwClassValidatorViolations', () => {
  it('throws a BadRequestException shaped exactly like every other explicit validation failure in this codebase', () => {
    const errors = validate({ email: 'not-an-email', address: { country: 'EG' } });

    try {
      throwClassValidatorViolations(errors);
      fail('expected throwClassValidatorViolations to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as {
        messageKey: string;
        violations: readonly { field: string }[];
      };
      expect(response.messageKey).toBe('errors.validation.failed');
      expect(response.violations.some((v) => v.field === 'email')).toBe(true);
      expect(response.violations.some((v) => v.field === 'unknown')).toBe(false);
    }
  });
});
