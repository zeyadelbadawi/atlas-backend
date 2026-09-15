/**
 * P54 — the plan catalog's bilingual text mapping.
 *
 * These cover the DEFENSIVE half of `toPlanResponse`, which is the part
 * that cannot be exercised through a normal request: `nameLocalized` is a
 * `Json?` column validated in application code rather than by the schema
 * (matching `limits`/`features`/`pricing`'s own precedent on this model),
 * so every malformed shape a row could hold must resolve to "no
 * translation" and fall back to the plain English `name` — never crash a
 * catalog read for every customer on the Plans page.
 */
import { toPlanResponse } from './plan.contract';
import type { Plan } from '@prisma/client';

function buildPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-1',
    key: 'growth',
    name: 'Growth',
    description: 'For growing organizations running multiple academies.',
    nameLocalized: null,
    descriptionLocalized: null,
    status: 'active',
    displayOrder: 2,
    limits: {},
    features: {},
    pricing: null,
    trialEligible: false,
    trialDurationDays: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as Plan;
}

describe('toPlanResponse — localized catalog text (P54)', () => {
  it('returns both locales when the row holds a well-formed pair', () => {
    const response = toPlanResponse(
      buildPlan({
        nameLocalized: { en: 'Growth', ar: 'النمو' } as never,
        descriptionLocalized: {
          en: 'For growing organizations.',
          ar: 'للمؤسسات.',
        } as never,
      }),
    );

    expect(response.nameLocalized).toEqual({ en: 'Growth', ar: 'النمو' });
    expect(response.descriptionLocalized).toEqual({
      en: 'For growing organizations.',
      ar: 'للمؤسسات.',
    });
  });

  it('keeps `name`/`description` unchanged and authoritative for English', () => {
    const response = toPlanResponse(
      buildPlan({ nameLocalized: { en: 'Growth', ar: 'النمو' } as never }),
    );

    // The additive contract: existing readers (audit labels, admin views,
    // checkout) see exactly what they saw before.
    expect(response.name).toBe('Growth');
    expect(response.description).toBe(
      'For growing organizations running multiple academies.',
    );
  });

  it('falls back to undefined for a plan with no translations (pre-P54 rows)', () => {
    const response = toPlanResponse(buildPlan());

    expect(response.nameLocalized).toBeUndefined();
    expect(response.descriptionLocalized).toBeUndefined();
  });

  it('treats a BLANK Arabic side as no translation, never as an empty name', () => {
    // Rendering `''` for a plan name in Arabic would be worse than showing
    // English: the customer would see an unnamed, unselectable card.
    const response = toPlanResponse(
      buildPlan({ nameLocalized: { en: 'Growth', ar: '   ' } as never }),
    );

    expect(response.nameLocalized).toBeUndefined();
  });

  it.each([
    ['a JSON string', 'Growth'],
    ['a JSON array', ['Growth']],
    ['a number', 42],
    ['an object missing `ar`', { en: 'Growth' }],
    ['an object whose `ar` is not a string', { en: 'Growth', ar: 5 }],
  ])('ignores %s rather than throwing', (_label, value) => {
    const response = toPlanResponse(buildPlan({ nameLocalized: value as never }));

    expect(response.nameLocalized).toBeUndefined();
    expect(response.name).toBe('Growth');
  });
});
