import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-MSG-05 A2 — 48 hours after signup, sent only when the organisation
 * has an academy and none of its websites is published (lead-gen §9.2
 * row 3). Once per tenant; never sent once a site is published.
 *
 * DRAFT COPY: pending owner approval (OQ-33) and Arabic review (RV-14).
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => "Your site isn't published yet",
    paragraphs: () => [
      'Your academy exists, but its website is not published, so students cannot see it yet.',
      'Review the pages and publish when you are ready. You can keep editing after it is live.',
    ],
    ctaLabel: 'Continue setup',
  }),
  ar: defineLocale({
    subject: () => 'موقعك لم يُنشر بعد',
    paragraphs: () => [
      'أكاديميتك موجودة، لكن موقعها غير منشور، لذا لا يستطيع الطلاب رؤيته بعد.',
      'راجع الصفحات وانشر الموقع عندما تكون مستعدًا. يمكنك متابعة التعديل بعد النشر.',
    ],
    ctaLabel: 'متابعة الإعداد',
  }),
};
