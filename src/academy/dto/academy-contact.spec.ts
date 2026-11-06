import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateAcademyDto } from './update-academy.dto';

/** B4 (UX audit) — the public contact phone and address had no limits. */
function failing(payload: Record<string, unknown>): string[] {
  const errors = validateSync(plainToInstance(UpdateAcademyDto, payload));
  const fields: string[] = [];
  for (const error of errors) {
    if (error.constraints) fields.push(error.property);
    for (const child of error.children ?? [])
      fields.push(`${error.property}.${child.property}`);
  }
  return fields;
}

describe('UpdateAcademyDto — contact phone and address', () => {
  it.each(['+20 2 1234 5678', '(02) 1234-5678', '01012345678', '+٢٠١٠١٢٣٤٥٦٧٨'])(
    'accepts the phone %s',
    (contactPhone) => {
      expect(failing({ contactPhone })).toEqual([]);
    },
  );

  it.each(['abc-phone', '12', 'phone?', '123456', '+20 100 CALL NOW'])(
    'refuses the phone %s',
    (contactPhone) => {
      expect(failing({ contactPhone })).toEqual(['contactPhone']);
    },
  );

  it('accepts null to clear the phone', () => {
    expect(failing({ contactPhone: null })).toEqual([]);
  });

  it('accepts a normal address and empty parts', () => {
    expect(
      failing({
        address: {
          street: '12 Tahrir St',
          city: 'Cairo',
          state: '',
          postalCode: '',
          country: 'EG',
        },
      }),
    ).toEqual([]);
    expect(failing({ address: { postalCode: '11511' } })).toEqual([]);
    expect(failing({ address: { postalCode: 'SW1A 1AA' } })).toEqual([]);
  });

  it('refuses a 600-character street and a malformed postal code', () => {
    expect(failing({ address: { street: 'x'.repeat(600) } })).toEqual(['address.street']);
    expect(failing({ address: { postalCode: 'ABC-!!-999999999' } })).toEqual([
      'address.postalCode',
    ]);
    expect(failing({ address: { city: 'c'.repeat(101) } })).toEqual(['address.city']);
  });
});
