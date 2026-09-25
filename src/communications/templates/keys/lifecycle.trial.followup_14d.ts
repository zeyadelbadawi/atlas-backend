import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §26 T5 — expiry + 14 days, and only for an organisation that actually
 * has content (at least one course or one student). An empty account that
 * never built anything gets no second nudge: signal, not volume.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your courses are still waiting',
    paragraphs: (v) => [
      `It has been two weeks since your trial ended on ${str(v, 'endedAtDate')}.`,
      'Your academy, its courses and everyone enrolled are all still stored. A plan brings the site and your students back in one step.',
    ],
    ctaLabel: 'Choose a plan',
  }),
  ar: defineLocale({
    subject: () => 'دوراتك ما زالت بانتظارك',
    paragraphs: (v) => [
      `مضى أسبوعان على انتهاء فترتك التجريبية في ${str(v, 'endedAtDate')}.`,
      'أكاديميتك ودوراتها وجميع المسجَّلين فيها ما زالت محفوظة. اختيار خطة يعيد الموقع وطلابك في خطوة واحدة.',
    ],
    ctaLabel: 'اختيار خطة',
  }),
};
