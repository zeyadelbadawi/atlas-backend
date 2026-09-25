import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §27 S2 / §28 — the receipt for a submitted transfer. The customer is
 * waiting on a human, so the email says so plainly and gives them the
 * reference they would otherwise have to guess at.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'We received your payment proof',
    paragraphs: (v) => [
      `Your proof of payment for ${str(v, 'amount')} ${str(v, 'currency')} was received on ${str(v, 'submittedAtDate')}.`,
      'A member of the team reviews it manually. You will get an email as soon as it is approved or if anything is missing.',
      'You do not need to send it again.',
    ],
    ctaLabel: 'View billing',
  }),
  ar: defineLocale({
    subject: () => 'استلمنا إثبات الدفع الخاص بك',
    paragraphs: (v) => [
      `استلمنا إثبات دفعك بقيمة ${str(v, 'amount')} ${str(v, 'currency')} في ${str(v, 'submittedAtDate')}.`,
      'يقوم أحد أعضاء الفريق بمراجعته يدويًا. ستصلك رسالة فور الموافقة عليه أو إذا كان ينقصه شيء.',
      'لا داعي لإرساله مرة أخرى.',
    ],
    ctaLabel: 'عرض الفوترة',
  }),
};
