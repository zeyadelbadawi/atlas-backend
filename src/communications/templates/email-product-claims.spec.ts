/**
 * Two copy rules every email must keep, checked on the RENDERED copy of
 * every template in both locales (so a claim cannot come back through a
 * different key):
 *
 * - NO INVOICES. Atlas issues no invoices — to organizations or to
 *   learners. `TenantInvoice` has no writer and billing offers no
 *   Invoices page, so an email that sends someone to "review invoices"
 *   sends them to something that does not exist. The receipt for a
 *   subscription is `lifecycle.subscription.activated`; for a course
 *   purchase it is the confirmation email itself.
 * - «أطلس» IN ARABIC. The Arabic copy names the platform «أطلس», never
 *   Latin "Atlas" in the middle of an Arabic sentence — including where
 *   the copy (or the footer) prints the platform's configured name, which
 *   `TemplateRegistry.render` writes as «أطلس» for the default name.
 */
import { TEMPLATES, TemplateRegistry } from './template-registry';
import type { RenderInput } from './template-registry';

const INPUT: RenderInput = {
  branding: { platformName: 'Atlas', platformUrl: 'https://platform.test' },
  actionUrl: 'https://platform.test/dashboard',
  settingsUrl: 'https://platform.test/settings/notifications',
};

/** A superset of what the templates read; no value contains "Atlas" itself. */
const VALUES = {
  academyName: 'Falcon Academy',
  organizationName: 'Falcon Group',
  courseTitle: 'Applied Cryptography',
  title: 'Custom logo',
  type: 'logo',
  name: 'Example Person',
  email: 'person@example.com',
  amount: '49.00',
  currency: 'EGP',
  methodType: 'bank_transfer',
  reason: 'Transfer reference did not match',
  submittedAtDate: '1 October 2026',
  periodStartDate: '2026-10-01',
  periodEndDate: '2026-11-01',
  role: 'student',
};

/** What a reader sees: the subject and the plain-text body, footer included. */
function body(templateId: string, locale: 'en' | 'ar'): string {
  const rendered = TemplateRegistry.render(templateId, locale, INPUT, VALUES);
  return `${rendered.subject}\n${rendered.text}`;
}

const TEMPLATE_IDS = Object.keys(TEMPLATES);

describe('email product claims', () => {
  it.each(TEMPLATE_IDS)('%s never mentions invoices (en)', (templateId) => {
    expect(body(templateId, 'en')).not.toMatch(/invoice/i);
  });

  it.each(TEMPLATE_IDS)('%s never mentions invoices (ar)', (templateId) => {
    expect(body(templateId, 'ar')).not.toMatch(/فاتور|فواتير/);
  });

  it.each(TEMPLATE_IDS)(
    '%s writes «أطلس», not Latin "Atlas", in Arabic',
    (templateId) => {
      expect(body(templateId, 'ar')).not.toMatch(/Atlas/);
    },
  );

  it('keeps a configured sender name other than the default verbatim', () => {
    const custom: RenderInput = {
      ...INPUT,
      branding: { ...INPUT.branding, platformName: 'Falcon Learning' },
    };
    const rendered = TemplateRegistry.render(
      'auth.password.changed',
      'ar',
      custom,
      VALUES,
    );
    expect(rendered.text).toContain('Falcon Learning');
    // English copy keeps the Latin product name.
    expect(body('platform.broadcast.sent', 'en')).toContain('Atlas');
  });

  it('points the subscription-payment approval at the payment history', () => {
    expect(body('platform.payment.approved', 'en')).toContain('payment history');
    expect(body('platform.payment.approved', 'ar')).toContain('سجل المدفوعات');
  });

  it("does not promise a receipt document under the learner's purchases", () => {
    expect(body('course.order.paid', 'en')).not.toMatch(/receipt/i);
    expect(body('course.order.paid', 'ar')).not.toMatch(/إيصال/);
  });
});
