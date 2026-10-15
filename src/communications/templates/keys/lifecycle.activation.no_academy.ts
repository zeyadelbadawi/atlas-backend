import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-MSG-05 A1 — 24 hours after signup, sent only while the organisation
 * has no academy (lead-gen §9.2 row 2). Once per tenant; never sent once
 * an academy exists.
 *
 * DRAFT COPY: pending owner approval (OQ-33) and Arabic review (RV-14).
 * No prices, no plan claims, no promised setup time.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'One step to start designing your academy',
    paragraphs: () => [
      'Your Atlas account is ready, but your academy has not been created yet.',
      'Give it a name, choose its web address and pick a theme. You can change the details later.',
    ],
    ctaLabel: 'Continue setup',
  }),
  ar: defineLocale({
    subject: () => 'خطوة واحدة لتبدأ تصميم أكاديميتك',
    paragraphs: () => [
      'حسابك على أطلس جاهز، لكن أكاديميتك لم تُنشأ بعد.',
      'اختر لها اسمًا وعنوانًا على الويب وتصميمًا. يمكنك تعديل التفاصيل لاحقًا.',
    ],
    ctaLabel: 'متابعة الإعداد',
  }),
};
