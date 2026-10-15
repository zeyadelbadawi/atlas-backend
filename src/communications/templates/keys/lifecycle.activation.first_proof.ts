import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-MSG-05 A4 — the first learner payment proof on one of the academy's
 * own manual methods (lead-gen §9.2 row 5), a guide beside the operational
 * `academy.payment.submitted` notice. Once per tenant; never sent once any
 * such payment has been approved or rejected.
 *
 * DRAFT COPY: pending owner approval (OQ-33) and Arabic review (RV-14).
 * No amount, course or learner name: the operational notice carries those.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your first payment proof has arrived',
    paragraphs: () => [
      'A student uploaded a payment proof for one of your courses.',
      "Check it on your academy's Payments page. Approve it to enrol the student, or reject it with a reason so they can try again.",
    ],
    ctaLabel: 'Review the payment',
  }),
  ar: defineLocale({
    subject: () => 'وصلك أول إثبات دفع',
    paragraphs: () => [
      'رفع أحد الطلاب إثبات دفع لإحدى دوراتك.',
      'راجعه في صفحة المدفوعات بأكاديميتك. وافق عليه ليُسجَّل الطالب في الدورة، أو ارفضه مع ذكر السبب ليتمكن من المحاولة مجددًا.',
    ],
    ctaLabel: 'مراجعة الدفعة',
  }),
};
