import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-MSG-05 A3 — day 4 after signup, sent only when the organisation has
 * an academy but still lacks a way to take payment or a course (lead-gen
 * §9.2 row 4). Once per tenant; never sent once both exist.
 *
 * DRAFT COPY: pending owner approval (OQ-33) and Arabic review (RV-14).
 * The methods named are the three manual types an academy can enable.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Set up payments and your first course',
    paragraphs: () => [
      'Students need two things before they can join: a way to pay you and a course to enrol in.',
      'If you have not done so yet, add the payment methods you accept (bank transfer, InstaPay or a mobile wallet) and create your first course with at least one lesson.',
    ],
    ctaLabel: 'Continue setup',
  }),
  ar: defineLocale({
    subject: () => 'جهّز طرق الدفع وأول دورة',
    paragraphs: () => [
      'يحتاج الطلاب إلى أمرين قبل الانضمام: طريقة للدفع لك، ودورة يسجّلون فيها.',
      'إن لم تفعل بعد، أضف طرق الدفع التي تقبلها (تحويل بنكي أو InstaPay أو محفظة إلكترونية) وأنشئ أول دورة تضم درسًا واحدًا على الأقل.',
    ],
    ctaLabel: 'متابعة الإعداد',
  }),
};
