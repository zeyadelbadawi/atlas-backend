/**
 * B0-MSG-05 part 3 — the four activation emails (A1–A4), EN and AR.
 *
 * The copy is DRAFT (owner approval OQ-33, Arabic review RV-14), so this
 * spec pins the contract rather than the wording: each email renders in
 * both locales with a subject, a body and a call to action; the Arabic
 * version is actually Arabic; no two steps share a subject; and nothing
 * in them is a price, a currency, a plan claim or a promised time. The
 * offer rules every lifecycle email follows ("free", review times, a
 * fixed trial length) are already enforced by `lifecycle-offer-copy.spec`.
 */
import { TemplateRegistry } from './template-registry';
import type { RenderInput } from './template-registry';

const INPUT: RenderInput = {
  branding: { platformName: 'Atlas', platformUrl: 'https://platform.test' },
  actionUrl: 'https://platform.test/dashboard',
  settingsUrl: 'https://platform.test/settings/notifications',
};

const VALUES = {
  anchorAt: '2026-10-01T09:00:00.000Z',
  planName: 'Growth',
  academyId: 'a1',
};

const ACTIVATION_KEYS = [
  'lifecycle.activation.no_academy',
  'lifecycle.activation.site_unpublished',
  'lifecycle.activation.payments_and_course',
  'lifecycle.activation.first_proof',
] as const;

const NO_CLAIMS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  {
    name: 'a price or amount',
    pattern: /\d+([.,]\d+)?\s*(EGP|USD|\$|ج\.م|جنيه)|(EGP|USD|\$)\s*\d/i,
  },
  { name: 'a currency word', pattern: /\bEGP\b|\bUSD\b|جنيه|دولار/i },
  {
    name: 'a plan name or price talk',
    pattern: /\bprice|\bplan\b|\bdiscount|سعر|خصم|الخطة|خطة/i,
  },
  { name: 'a promised time', pattern: /\bminutes?\b|\bhours?\b|دقائق|دقيقة|ساعة|ساعات/i },
  {
    name: 'a superlative claim',
    pattern: /\bbest\b|\bfastest\b|\bguarantee|الأفضل|الأسرع|نضمن|مضمون/i,
  },
];

describe('activation emails A1–A4 (B0-MSG-05)', () => {
  it.each(ACTIVATION_KEYS)(
    '%s renders in both locales with a subject, body and CTA',
    (key) => {
      for (const locale of ['en', 'ar'] as const) {
        const rendered = TemplateRegistry.render(key, locale, INPUT, VALUES);
        expect(rendered.subject.trim()).not.toBe('');
        expect(rendered.text).toContain(INPUT.actionUrl);
        expect(rendered.html).toContain(INPUT.actionUrl);
        expect(rendered.text).not.toMatch(/undefined|\{\{|\$\{/);
      }
    },
  );

  it.each(ACTIVATION_KEYS)('%s is written in Arabic for the ar locale', (key) => {
    const ar = TemplateRegistry.render(key, 'ar', INPUT, VALUES);
    expect(ar.subject).toMatch(/[؀-ۿ]/);
    expect(ar.subject).not.toMatch(/[A-Za-z]{4,}/);
  });

  it('gives every step its own subject, in each locale', () => {
    for (const locale of ['en', 'ar'] as const) {
      const subjects = ACTIVATION_KEYS.map(
        (key) => TemplateRegistry.render(key, locale, INPUT, VALUES).subject,
      );
      expect(new Set(subjects).size).toBe(ACTIVATION_KEYS.length);
    }
  });

  for (const key of ACTIVATION_KEYS) {
    for (const locale of ['en', 'ar'] as const) {
      it(`${key} (${locale}) makes no price, plan, timing or superlative claim`, () => {
        const visible = paragraphsOf(key, locale);
        for (const { name, pattern } of NO_CLAIMS) {
          expect({ key, locale, claim: name, found: pattern.test(visible) }).toEqual({
            key,
            locale,
            claim: name,
            found: false,
          });
        }
      });
    }
  }
});

/** The template's own subject and paragraphs, without the shared layout and footer. */
function paragraphsOf(
  key: (typeof ACTIVATION_KEYS)[number],
  locale: 'en' | 'ar',
): string {
  const rendered = TemplateRegistry.render(key, locale, INPUT, VALUES);
  const footerStart = rendered.text.indexOf(INPUT.settingsUrl);
  const text = footerStart === -1 ? rendered.text : rendered.text.slice(0, footerStart);
  return `${rendered.subject}\n${text}`;
}
