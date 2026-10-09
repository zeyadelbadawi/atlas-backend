/**
 * The server's phone rule (docs/USER_PHONE.md) — what is accepted, what is
 * refused and why, and that the stored value is the server's own E.164.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  normalizePhoneCountry,
  normalizePhoneNumber,
  toAsciiDigits,
} from './phone-number.policy';
import { RegisterDto } from '../dto/register.dto';
import { UpdatePhoneDto } from '../dto/update-phone.dto';
import { classValidatorErrorsToViolations } from '../../common/validation/class-validator-violations.util';
import { PhoneVerificationService } from './phone-verification.service';
import type { PhoneVerificationProvider } from './phone-verification.service';
import type { ConfigService } from '@nestjs/config';

describe('normalizePhoneNumber', () => {
  it.each([
    // [typed, country, e164]
    ['01001234567', 'EG', '+201001234567'],
    ['010 0123 4567', 'EG', '+201001234567'],
    ['+20 100 123 4567', 'EG', '+201001234567'],
    ['(010) 0123-4567', 'EG', '+201001234567'],
    ['1001234567', 'EG', '+201001234567'],
    ['٠١٠٠١٢٣٤٥٦٧', 'EG', '+201001234567'],
    ['۰۱۰۰۱۲۳۴۵۶۷', 'EG', '+201001234567'],
    ['0501234567', 'SA', '+966501234567'],
    ['0501234567', 'sa', '+966501234567'],
    ['0151 23456789', 'DE', '+4915123456789'],
    // US/Canada report FIXED_LINE_OR_MOBILE — accepted.
    ['(201) 555-0123', 'US', '+12015550123'],
  ])('accepts %s (%s) as %s', (typed, country, e164) => {
    const result = normalizePhoneNumber(typed, country);
    expect(result).toEqual({
      ok: true,
      phone: expect.objectContaining({ e164, country: country.toUpperCase() }),
    });
  });

  it('splits the stored number into calling code and national number', () => {
    expect(normalizePhoneNumber('01001234567', 'EG')).toEqual({
      ok: true,
      phone: {
        e164: '+201001234567',
        country: 'EG',
        callingCode: '20',
        nationalNumber: '1001234567',
      },
    });
  });

  it.each([
    ['0223456789', 'EG', 'not_mobile'], // Cairo landline
    ['0800 123 4567', 'GB', 'not_mobile'], // toll-free
    ['+966501234567', 'EG', 'country_mismatch'],
    ['(514) 555-0123', 'US', 'country_mismatch'], // a Canadian number under US
    ['07700900123', 'GB', 'invalid_number'], // Ofcom drama range
    ['0100123', 'EG', 'invalid_number'],
    ['call me 01001234567', 'EG', 'invalid_number'],
    ['01001234567 ext 5', 'EG', 'invalid_number'],
    ['01001234567;5', 'EG', 'invalid_number'],
    ['<script>alert(1)</script>', 'EG', 'invalid_number'],
    ['++201001234567', 'EG', 'invalid_number'],
    ['', 'EG', 'invalid_number'],
    ['   ', 'EG', 'invalid_number'],
    ['0'.repeat(33), 'EG', 'invalid_number'],
    ['01001234567', 'XX', 'invalid_country'],
    ['01001234567', 'EGY', 'invalid_country'],
    ['01001234567', '', 'invalid_country'],
  ])('refuses %s (%s): %s', (typed, country, reason) => {
    expect(normalizePhoneNumber(typed, country)).toEqual({ ok: false, reason });
  });

  it('refuses non-string input', () => {
    expect(normalizePhoneNumber(1001234567, 'EG')).toEqual({
      ok: false,
      reason: 'invalid_number',
    });
    expect(normalizePhoneNumber('01001234567', 20)).toEqual({
      ok: false,
      reason: 'invalid_country',
    });
  });

  it('maps Arabic-Indic digits only', () => {
    expect(toAsciiDigits('+٢٠ ۱۰۰')).toBe('+20 100');
    expect(normalizePhoneCountry('eg')).toBe('EG');
    expect(normalizePhoneCountry('zz')).toBeNull();
  });
});

async function violationsFor(cls: new () => RegisterDto | UpdatePhoneDto, body: object) {
  const instance: object = plainToInstance(cls, body);
  return classValidatorErrorsToViolations(
    await validate(instance, { whitelist: true, forbidNonWhitelisted: true }),
  );
}

describe('phone fields in DTOs', () => {
  const base = {
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    password: 'correct-horse',
  };

  it('registration without any phone field is valid (older sign-up pages)', async () => {
    expect(await violationsFor(RegisterDto, base)).toEqual([]);
  });

  it('registration with a valid phone is valid', async () => {
    expect(
      await violationsFor(RegisterDto, {
        ...base,
        phoneNumber: '010 0123 4567',
        phoneCountry: 'EG',
      }),
    ).toEqual([]);
  });

  it('one half of the pair requires the other', async () => {
    expect(
      await violationsFor(RegisterDto, { ...base, phoneNumber: '01001234567' }),
    ).toEqual(
      expect.arrayContaining([
        { field: 'phoneCountry', messageKey: 'validation:required' },
      ]),
    );
    expect(await violationsFor(RegisterDto, { ...base, phoneCountry: 'EG' })).toEqual(
      expect.arrayContaining([
        { field: 'phoneNumber', messageKey: 'validation:required' },
      ]),
    );
  });

  it.each([
    ['0223456789', 'EG', 'phoneNumber', 'validation:phoneNotMobile'],
    ['+966501234567', 'EG', 'phoneNumber', 'validation:phoneCountryMismatch'],
    ['12', 'EG', 'phoneNumber', 'validation:invalidPhone'],
    ['01001234567', 'XX', 'phoneCountry', 'validation:invalidPhoneCountry'],
  ])('%s (%s) → exactly one %s violation: %s', async (number, country, field, key) => {
    const violations = await violationsFor(UpdatePhoneDto, {
      phoneNumber: number,
      phoneCountry: country,
    });
    expect(violations).toEqual([{ field, messageKey: key }]);
  });

  it('the profile DTO requires both fields', async () => {
    const violations = await violationsFor(UpdatePhoneDto, {});
    expect(violations.map((v) => v.field).sort()).toEqual(
      expect.arrayContaining(['phoneCountry', 'phoneNumber']),
    );
  });
});

describe('PhoneVerificationService', () => {
  const config = (mode: 'on' | 'off') =>
    ({ get: () => ({ phoneVerificationMode: mode }) }) as unknown as ConfigService;
  const provider: PhoneVerificationProvider = {
    channel: 'whatsapp',
    sendCode: jest.fn(),
  };

  it('is disabled by default and never offers verification', () => {
    expect(new PhoneVerificationService(config('off')).availability()).toEqual({
      available: false,
      reason: 'disabled',
    });
    expect(new PhoneVerificationService(config('off'), provider).availability()).toEqual({
      available: false,
      reason: 'disabled',
    });
  });

  it('reports a missing provider when switched on without one (today)', () => {
    expect(new PhoneVerificationService(config('on')).availability()).toEqual({
      available: false,
      reason: 'provider_not_configured',
    });
  });

  it('offers the bound provider’s channel only when switched on', () => {
    expect(new PhoneVerificationService(config('on'), provider).availability()).toEqual({
      available: true,
      channel: 'whatsapp',
    });
    expect(provider.sendCode).not.toHaveBeenCalled();
  });
});
