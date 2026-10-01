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
