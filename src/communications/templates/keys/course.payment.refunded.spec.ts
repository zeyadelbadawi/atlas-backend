/**
 * The learner's "refund recorded" email for a payment made to the ACADEMY.
 * It reports what the academy recorded, carries the owner's note when there
 * is one, and never says that Atlas refunded or moved the money.
 */
import { TemplateRegistry } from '../template-registry';
import type { RenderInput } from '../template-registry';

const INPUT: RenderInput = {
  branding: {
    academyName: 'Falcon Academy',
    academyHost: 'falcon.atlas.test',
    platformName: 'Atlas',
    platformUrl: 'https://platform.test',
  },
  actionUrl: 'https://falcon.atlas.test/my/purchases',
  settingsUrl: 'https://falcon.atlas.test/settings/notifications',
};

const VALUES = {
  courseTitle: 'Applied Cryptography',
  amount: '1500.00',
  currency: 'EGP',
};

describe('course.payment.refunded', () => {
  it.each(['en', 'ar'] as const)(
    'names the course, the amount and the academy (%s)',
    (locale) => {
      const { subject, text } = TemplateRegistry.render(
        'course.payment.refunded',
        locale,
        INPUT,
        VALUES,
      );
      expect(subject).toContain('Applied Cryptography');
      expect(text).toContain('1500.00 EGP');
      expect(text).toMatch(locale === 'en' ? /The academy recorded/ : /سجّلت الأكاديمية/);
      expect(text).toMatch(
        locale === 'en' ? /contact the academy/ : /تواصل مع الأكاديمية/,
      );
    },
  );

  it('includes the owner note only when there is one', () => {
    const withNote = TemplateRegistry.render('course.payment.refunded', 'en', INPUT, {
      ...VALUES,
      note: 'Sent back by InstaPay.',
    });
    expect(withNote.text).toContain('Note from the academy: Sent back by InstaPay.');
    const without = TemplateRegistry.render(
      'course.payment.refunded',
      'en',
      INPUT,
      VALUES,
    );
    expect(without.text).not.toContain('Note from the academy');
  });

  it('never claims Atlas refunded the money', () => {
    for (const locale of ['en', 'ar'] as const) {
      const { text } = TemplateRegistry.render(
        'course.payment.refunded',
        locale,
        INPUT,
        VALUES,
      );
      expect(text).not.toMatch(/Atlas refunded|refunded by Atlas|ردّت أطلس|استردّت أطلس/);
    }
  });
});
