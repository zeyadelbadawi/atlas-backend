/**
 * W8 — the subscription receipt must state gifted days when, and only
 * when, the approval that produced it granted them.
 *
 * With a gift: the day count, the gift period, and the paid period (from
 * the gift's end to the renewal/expiry date) as a separate statement.
 * Without one: not a word about gifts — no "0 gifted days", no empty
 * gift line — in either locale.
 */
import { TemplateRegistry } from '../template-registry';
import type { RenderInput } from '../template-registry';
import { template } from './lifecycle.subscription.activated';

const KEY = 'lifecycle.subscription.activated';

const INPUT: RenderInput = {
  branding: { platformName: 'Atlas', platformUrl: 'https://platform.test' },
  actionUrl: 'https://platform.test/dashboard/tenant/subscription',
  settingsUrl: 'https://platform.test/settings/notifications',
};

const GIFT_START = '2026-10-04 09:30 UTC';
const GIFT_END = '2026-10-11 09:30 UTC';
const PAID_END = '2026-11-11 09:30 UTC';

const BASE = {
  anchorAt: '2026-11-11T09:30:00.000Z',
  planName: 'Growth',
  periodStartDate: GIFT_END,
  periodEndDate: PAID_END,
  academiesLimit: '2',
  studentsLimit: '500',
  coursesLimit: 'unlimited',
};

const WITH_GIFT = {
  ...BASE,
  giftedDays: 7,
  giftStartDate: GIFT_START,
  giftEndDate: GIFT_END,
};

/** A renewal: the paid period simply runs from the previous end. */
const NO_GIFT = {
  ...BASE,
  periodStartDate: '2026-11-11 09:30 UTC',
  periodEndDate: '2026-12-11 09:30 UTC',
};

const EN_GIFT_WORDS = /gift/i;
const AR_GIFT_WORDS = /مُهداة|مهداة|هدية/;

function render(locale: 'en' | 'ar', values: Record<string, unknown>) {
  return TemplateRegistry.render(KEY, locale, INPUT, values);
}

describe('lifecycle.subscription.activated — gifted days', () => {
  it('is version 2 (the gifted-days copy)', () => {
    expect(template.version).toBe('2');
  });

  describe('en', () => {
    it('with a gift: states the count, the gift period and the paid period separately', () => {
      const { text, html, subject } = render('en', WITH_GIFT);
      expect(subject).toBe('Your Growth subscription is active');
      expect(text).toContain(
        `Gifted days: 7 days, from ${GIFT_START} to ${GIFT_END}. These days are free and are not taken from the period you paid for.`,
      );
      expect(text).toContain(
        `Paid subscription period: from ${GIFT_END} to ${PAID_END}. Your subscription expires on ${PAID_END} unless you renew it.`,
      );
      // The plain "active from X to Y" sentence would claim the paid start
      // is when the subscription began — not with a gift in front of it.
      expect(text).not.toContain('is active from');
      expect(html).toContain('Gifted days: 7 days');
      expect(html).toContain('Paid subscription period');
      expect(html).toContain('dir="ltr"');
    });

    it('without a gift: the plain receipt, no gift wording at all', () => {
      const { text, html } = render('en', NO_GIFT);
      expect(text).toContain(
        'Your subscription to Growth is active from 2026-11-11 09:30 UTC to 2026-12-11 09:30 UTC.',
      );
      expect(text).not.toMatch(EN_GIFT_WORDS);
      expect(html).not.toMatch(EN_GIFT_WORDS);
      expect(text).not.toContain('Paid subscription period');
    });

    it.each([
      ['a zero count', { giftedDays: 0 }],
      ['a string zero', { giftedDays: '0' }],
      ['a negative count', { giftedDays: -3 }],
      ['a missing start date', { giftStartDate: '' }],
      ['a missing end date', { giftEndDate: undefined }],
    ])('treats %s as no gift — never "0 gifted days"', (_label, override) => {
      const { text, html } = render('en', { ...WITH_GIFT, ...override });
      expect(text).not.toMatch(EN_GIFT_WORDS);
      expect(html).not.toMatch(EN_GIFT_WORDS);
      expect(text).not.toMatch(/\b0 days?\b/);
    });
  });

  describe('ar', () => {
    it('with a gift: states the count, the gift period and the paid period separately, RTL', () => {
      const { text, html, subject } = render('ar', WITH_GIFT);
      expect(subject).toBe('اشتراكك في Growth فعّال الآن');
      expect(text).toContain('الأيام المُهداة: 7 أيام');
      expect(text).toContain('هذه الأيام مجانية ولا تُخصم من الفترة التي دفعت مقابلها.');
      expect(text).toContain('فترة الاشتراك المدفوعة: من');
      expect(text).toContain('ما لم تجدّده.');
      // Every date is present, isolated left-to-right inside the RTL text.
      for (const date of [GIFT_START, GIFT_END, PAID_END]) {
        expect(text).toContain(`⁦${date}⁩`);
        expect(html).toContain(`⁦${date}⁩`);
      }
      expect(html).toContain('<html lang="ar" dir="rtl">');
      expect(html).toContain('الأيام المُهداة');
    });

    it('uses the Arabic counted forms for the day count', () => {
      expect(render('ar', { ...WITH_GIFT, giftedDays: 14 }).text).toContain(
        'الأيام المُهداة: 14 يومًا',
      );
      expect(render('ar', { ...WITH_GIFT, giftedDays: 5 }).text).toContain(
        'الأيام المُهداة: 5 أيام',
      );
    });

    it('without a gift: the plain receipt, no gift wording at all', () => {
      const { text, html } = render('ar', NO_GIFT);
      expect(text).toContain(
        'اشتراكك في Growth فعّال من ⁦2026-11-11 09:30 UTC⁩ حتى ⁦2026-12-11 09:30 UTC⁩.',
      );
      expect(text).not.toMatch(AR_GIFT_WORDS);
      expect(html).not.toMatch(AR_GIFT_WORDS);
      expect(text).not.toContain('فترة الاشتراك المدفوعة');
    });

    it('treats a zero count as no gift', () => {
      const { text } = render('ar', { ...WITH_GIFT, giftedDays: 0 });
      expect(text).not.toMatch(AR_GIFT_WORDS);
    });
  });
});
