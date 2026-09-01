import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
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
