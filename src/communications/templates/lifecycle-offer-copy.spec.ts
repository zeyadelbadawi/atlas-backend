/**
 * B0-MSG-04 — the lifecycle emails (trial and subscription sequences) say
 * nothing the approved offer does not back, in either locale:
 *
 *   - no "free" / «مجاني» next to the plan (R-03): there is no free plan,
 *     and gifted days are described as a gift;
 *   - no payment-review or transfer TIME (OQ-23: no review SLA is
 *     published, so no "a working day or two");
 *   - no hard-coded trial length: the 14-day trial is a plan setting the
 *     Platform Owner can change, so the copy names dates, never "14 days".
 *
 * Every `lifecycle.*` template is rendered with a values bag that exercises
 * its optional branches (gifted days, limits), so a later copy change that
 * reintroduces one of these phrases fails here.
 */
import { TEMPLATES, TemplateRegistry } from './template-registry';
import type { RenderInput } from './template-registry';

const INPUT: RenderInput = {
  branding: { platformName: 'Atlas', platformUrl: 'https://platform.test' },
  actionUrl: 'https://platform.test/dashboard/tenant/subscription',
  settingsUrl: 'https://platform.test/settings/notifications',
};

const VALUES = {
  anchorAt: '2026-11-11T09:30:00.000Z',
  planName: 'Growth',
  trialEndsAtDate: '2026-10-27 09:30 UTC',
  periodStartDate: '2026-10-11 09:30 UTC',
  periodEndDate: '2026-11-11 09:30 UTC',
  renewalDate: '2026-11-11 09:30 UTC',
  graceEndsAtDate: '2026-11-18 09:30 UTC',
  giftedDays: 7,
  giftStartDate: '2026-10-04 09:30 UTC',
  giftEndDate: '2026-10-11 09:30 UTC',
  academiesLimit: '2',
  studentsLimit: '500',
  coursesLimit: 'unlimited',
  amount: 1190,
  currency: 'EGP',
  proofId: 'proof-1',
  submittedAtDate: '2026-10-13 09:30 UTC',
  effectiveDate: '2026-12-11',
  oldPrice: '1190',
  newPrice: '1290',
};

const LIFECYCLE_KEYS = Object.keys(TEMPLATES).filter((key) =>
  key.startsWith('lifecycle.'),
);

const BANNED: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: '"free" (R-03)', pattern: /\bfree\b/i },
  { name: '«مجاني» (R-03)', pattern: /مجان/ },
  {
    name: 'a review/transfer time (OQ-23)',
    pattern: /working days?|business days?|day or two|يوم عمل|أيام عمل|يومين/i,
  },
  { name: 'a hard-coded trial length', pattern: /\b14[- ]day|\b14 days|١٤ يوم|14 يوم/i },
];

describe('lifecycle email copy matches the approved offer (B0-MSG-04)', () => {
  it('covers the lifecycle templates', () => {
    expect(LIFECYCLE_KEYS.length).toBeGreaterThanOrEqual(20);
  });

  for (const key of LIFECYCLE_KEYS) {
    for (const locale of ['en', 'ar'] as const) {
      it(`${key} (${locale}) avoids free, review times and a fixed trial length`, () => {
        const rendered = TemplateRegistry.render(key, locale, INPUT, VALUES);
        const visible = `${rendered.subject}\n${rendered.text}`;
        for (const { name, pattern } of BANNED) {
          expect({ key, locale, banned: name, found: pattern.test(visible) }).toEqual({
            key,
            locale,
            banned: name,
            found: false,
          });
        }
      });
    }
  }
});
