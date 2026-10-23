import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SubmitContactMessageDto } from './submit-contact-message.dto';

describe('SubmitContactMessageDto', () => {
  // Same whitelist settings as the global `ValidationPipe` (main.ts).
  async function errorsFor(payload: Record<string, unknown>) {
    const dto = plainToInstance(SubmitContactMessageDto, payload);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    return errors.map((error) => error.property);
  }

  const valid = { name: 'Visitor', email: 'visitor@example.com', message: 'Hello' };

  it('accepts a valid message without the honeypot', async () => {
    await expect(errorsFor(valid)).resolves.toEqual([]);
  });

  it('accepts the optional `company` honeypot field', async () => {
    await expect(errorsFor({ ...valid, company: 'Anything' })).resolves.toEqual([]);
  });

  it('rejects a non-string or over-long `company`', async () => {
    await expect(errorsFor({ ...valid, company: 42 })).resolves.toEqual(['company']);
    await expect(errorsFor({ ...valid, company: 'x'.repeat(201) })).resolves.toEqual([
      'company',
    ]);
  });

  it('still rejects unknown fields', async () => {
    await expect(errorsFor({ ...valid, website: 'x' })).resolves.toEqual(['website']);
  });

  it('rejects an invalid email', async () => {
    await expect(errorsFor({ ...valid, email: 'not-an-email' })).resolves.toEqual([
      'email',
    ]);
  });

  it.each([
    ['name', 201],
    ['email', 321],
    ['message', 5001],
  ])('rejects an over-long %s', async (field, length) => {
    const value =
      field === 'email'
        ? `${'a'.repeat(length - '@example.com'.length)}@example.com`
        : 'a'.repeat(length);
    await expect(errorsFor({ ...valid, [field]: value })).resolves.toContain(field);
  });

  it.each(['name', 'email', 'message'])('rejects a missing %s', async (field) => {
    const payload: Record<string, unknown> = { ...valid };
    delete payload[field];
    await expect(errorsFor(payload)).resolves.toContain(field);
  });
});

/**
 * One endpoint, two forms (CMS phase 3d, batch C): the Contact form's
 * rules are unchanged, and a "register your interest" submission needs a
 * name, a valid mobile number and the section it came from.
 */
describe('SubmitContactMessageDto — the interest form (CMS phase 3d, batch C)', () => {
  async function errorsFor(payload: Record<string, unknown>): Promise<string[]> {
    const errors = await validate(plainToInstance(SubmitContactMessageDto, payload), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return errors.map((error) => error.property).sort();
  }

  const contact = { name: 'Visitor', email: 'visitor@example.com', message: 'Hello' };
  const interest = {
    kind: 'interest',
    name: 'Mariam',
    phoneNumber: '01001234567',
    phoneCountry: 'EG',
    sectionId: 'interest-1',
  };

  it('keeps the Contact form exactly as it was: name, email and message required', async () => {
    await expect(errorsFor(contact)).resolves.toEqual([]);
    await expect(errorsFor({ ...contact, kind: 'contact' })).resolves.toEqual([]);
    await expect(errorsFor({ name: 'Visitor' })).resolves.toEqual(['email', 'message']);
  });

  it('accepts an interest submission with only name, phone and section', async () => {
    await expect(errorsFor(interest)).resolves.toEqual([]);
  });

  it('accepts every optional interest field', async () => {
    await expect(
      errorsFor({
        ...interest,
        email: 'mariam@example.com',
        message: 'Which days?',
        choice: 'g1',
        locale: 'ar',
        company: '',
      }),
    ).resolves.toEqual([]);
  });

  it('requires the phone and the section on an interest submission', async () => {
    await expect(errorsFor({ kind: 'interest', name: 'Mariam' })).resolves.toEqual([
      'phoneCountry',
      'phoneNumber',
      'sectionId',
    ]);
  });

  it('checks a sent email, an empty value and the phone itself', async () => {
    await expect(errorsFor({ ...interest, email: 'not-an-email' })).resolves.toEqual([
      'email',
    ]);
    await expect(errorsFor({ ...interest, message: '' })).resolves.toEqual(['message']);
    await expect(errorsFor({ ...interest, choice: '' })).resolves.toEqual(['choice']);
    await expect(errorsFor({ ...interest, phoneNumber: '123' })).resolves.toEqual([
      'phoneNumber',
    ]);
    // A landline cannot take a call-back on WhatsApp/SMS: mobile numbers only.
    await expect(errorsFor({ ...interest, phoneNumber: '0223456789' })).resolves.toEqual([
      'phoneNumber',
    ]);
  });

  it('refuses an unknown kind or locale', async () => {
    await expect(errorsFor({ ...interest, kind: 'newsletter' })).resolves.toContain(
      'kind',
    );
    await expect(errorsFor({ ...interest, locale: 'fr' })).resolves.toEqual(['locale']);
  });
});
