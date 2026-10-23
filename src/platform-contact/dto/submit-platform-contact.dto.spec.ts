import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SubmitPlatformContactDto } from './submit-platform-contact.dto';

describe('SubmitPlatformContactDto', () => {
  // Same settings as the global `ValidationPipe` (main.ts): transform runs
  // first, so the @Transform trims are what validation sees.
  function toDto(payload: Record<string, unknown>): SubmitPlatformContactDto {
    return plainToInstance(SubmitPlatformContactDto, payload);
  }

  async function errorsFor(payload: Record<string, unknown>): Promise<string[]> {
    const errors = await validate(toDto(payload), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return errors.map((error) => error.property).sort();
  }

  const valid = {
    name: 'Layla Haddad',
    email: 'layla@example.com',
    topic: 'sales',
    message: 'We run three academies and want to move them to Atlas.',
    startedAt: 1_790_000_000_000,
  };

  it('accepts a minimal valid enquiry', async () => {
    await expect(errorsFor(valid)).resolves.toEqual([]);
  });

  it('accepts every optional field', async () => {
    await expect(
      errorsFor({
        ...valid,
        organizationName: 'Falcon Learning',
        locale: 'ar',
        sourcePath: '/',
        company: '',
      }),
    ).resolves.toEqual([]);
  });

  it('trims text fields and normalizes the email', () => {
    const dto = toDto({
      ...valid,
      name: '  Layla  ',
      email: '  Layla@Example.COM ',
      message: `  ${valid.message}  `,
      organizationName: '  Falcon  ',
    });
    expect(dto.name).toBe('Layla');
    expect(dto.email).toBe('layla@example.com');
    expect(dto.message).toBe(valid.message);
    expect(dto.organizationName).toBe('Falcon');
  });

  it('treats a blank organization as absent', () => {
    expect(toDto({ ...valid, organizationName: '   ' }).organizationName).toBeUndefined();
  });

  it.each(['name', 'message'])('rejects a whitespace-only %s', async (field) => {
    await expect(errorsFor({ ...valid, [field]: '      \n\t ' })).resolves.toEqual([
      field,
    ]);
  });

  it('rejects a too-short name and message after trimming', async () => {
    await expect(errorsFor({ ...valid, name: ' a ' })).resolves.toEqual(['name']);
    await expect(errorsFor({ ...valid, message: '  short  ' })).resolves.toEqual([
      'message',
    ]);
  });

  it.each([
    ['name', 201],
    ['organizationName', 201],
    ['message', 5001],
  ])('rejects an over-long %s', async (field, length) => {
    await expect(errorsFor({ ...valid, [field]: 'a'.repeat(length) })).resolves.toEqual([
      field,
    ]);
  });

  it('rejects an over-long or invalid email', async () => {
    await expect(
      errorsFor({ ...valid, email: `${'a'.repeat(310)}@example.com` }),
    ).resolves.toEqual(['email']);
    await expect(errorsFor({ ...valid, email: 'not-an-email' })).resolves.toEqual([
      'email',
    ]);
  });

  it('accepts exactly the maximum lengths', async () => {
    await expect(
      errorsFor({
        ...valid,
        name: 'a'.repeat(200),
        organizationName: 'b'.repeat(200),
        message: 'c'.repeat(5000),
      }),
    ).resolves.toEqual([]);
  });

  it('accepts the founding topic (B2 Founding Academies)', async () => {
    await expect(errorsFor({ ...valid, topic: 'founding' })).resolves.toEqual([]);
  });

  it('rejects an unknown topic and a missing topic', async () => {
    await expect(errorsFor({ ...valid, topic: 'billing' })).resolves.toEqual(['topic']);
    await expect(errorsFor({ ...valid, topic: undefined })).resolves.toEqual(['topic']);
  });

  it('requires a numeric startedAt', async () => {
    await expect(errorsFor({ ...valid, startedAt: undefined })).resolves.toEqual([
      'startedAt',
    ]);
    await expect(errorsFor({ ...valid, startedAt: 'yesterday' })).resolves.toEqual([
      'startedAt',
    ]);
    await expect(errorsFor({ ...valid, startedAt: -1 })).resolves.toEqual(['startedAt']);
  });

  it('rejects a sourcePath that is a URL or carries a query', async () => {
    await expect(
      errorsFor({ ...valid, sourcePath: 'https://evil.test/' }),
    ).resolves.toEqual(['sourcePath']);
    await expect(errorsFor({ ...valid, sourcePath: '/?q=1' })).resolves.toEqual([
      'sourcePath',
    ]);
  });

  it('rejects an unsupported locale', async () => {
    await expect(errorsFor({ ...valid, locale: 'fr' })).resolves.toEqual(['locale']);
  });

  it('rejects an over-long or non-string honeypot', async () => {
    await expect(errorsFor({ ...valid, company: 'x'.repeat(201) })).resolves.toEqual([
      'company',
    ]);
    await expect(errorsFor({ ...valid, company: 42 })).resolves.toEqual(['company']);
  });

  it('rejects server-owned and unknown properties', async () => {
    await expect(
      errorsFor({ ...valid, status: 'read', ipHash: 'x', website: 'y' }),
    ).resolves.toEqual(['ipHash', 'status', 'website']);
  });

  // B0-SUP-04 / B0-ANL-04 — additive optional fields.
  it('accepts the WhatsApp number, both consents, qualification and attribution', async () => {
    await expect(
      errorsFor({
        ...valid,
        phoneNumber: '01001234567',
        phoneCountry: 'EG',
        contactConsent: true,
        marketingConsent: false,
        requesterRole: 'academy_owner',
        subject: 'Mathematics',
        studentBand: '50_200',
        preferredChannel: 'whatsapp',
        attribution: { utmSource: 'facebook', referrerDomain: 'example.org' },
      }),
    ).resolves.toEqual([]);
  });

  it('rejects a consent that is not a boolean and a half-given phone', async () => {
    await expect(errorsFor({ ...valid, marketingConsent: 'yes' })).resolves.toEqual([
      'marketingConsent',
    ]);
    await expect(errorsFor({ ...valid, phoneNumber: '01001234567' })).resolves.toEqual([
      'phoneCountry',
    ]);
  });

  it('rejects unknown qualification values and unknown attribution keys', async () => {
    await expect(
      errorsFor({ ...valid, studentBand: 'lots', preferredChannel: 'fax' }),
    ).resolves.toEqual(['preferredChannel', 'studentBand']);
    await expect(
      errorsFor({ ...valid, attribution: { utmSource: 'x', gclid: 'y' } }),
    ).resolves.toEqual(['attribution']);
  });
});
