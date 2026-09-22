/**
 * Email content templates — Phase P17.
 *
 * SPECIFICATION-UNDEFINED, documented rather than fabricated: no
 * server-side email-templating or localization system exists anywhere in
 * this codebase (the frontend's i18next setup only ever renders inside
 * the SPA, never into an email an external inbox receives), and neither
 * the master plan nor the frontend defines one for P17. Building a full
 * localized-email-template engine mirroring the frontend's i18next setup
 * is disproportionate to this phase's scope (master plan §21 P17's own
 * "keep P17 appropriately scoped" instruction) — every template below is
 * a small, English-only, server-side function, not a claim that this is
 * the final production email design. Revisit if/when Atlas needs
 * localized transactional email.
 */
import type { TransactionalEmailInput } from '../../identity/services/email-provider.interface';

export const EMAIL_TEMPLATE_KEYS = [
  'provisioning_completed',
  'provisioning_failed',
  'course_order_paid',
  'course_order_payment_failed',
  'course_order_refunded',
  'platform_payment_approved',
  'platform_payment_rejected',
  'support_case_reply',
  'password_changed',
  // Phase 12 — a session recording finished processing. Sent to the HOST
  // only; students are not emailed, because attending a session does not
  // grant access to its recording.
  'live_session_recording_available',
  // P64 Phase 3 — assessment and certificate lifecycle (EN/AR by `locale`).
  'assignment_graded',
  'quiz_attempt_graded',
  'certificate_issued',
  'certificate_revoked',
] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

type TemplateBody = Pick<TransactionalEmailInput, 'subject' | 'text'>;
type TemplateRenderer = (values: Record<string, unknown>) => TemplateBody;

function str(values: Record<string, unknown>, key: string, fallback = ''): string {
  const value = values[key];
  return typeof value === 'string' ? value : fallback;
}

/** P64 Phase 3 — the learner's preferred locale, when the caller knows it. */
function isArabic(values: Record<string, unknown>): boolean {
  return str(values, 'locale') === 'ar';
}

const TEMPLATES: Record<EmailTemplateKey, TemplateRenderer> = {
  assignment_graded: (v) =>
    isArabic(v)
      ? {
          subject: 'تم تقييم واجبك',
          text: `تم تقييم واجبك "${str(v, 'assignmentTitle')}"${str(v, 'score') ? ` بدرجة ${str(v, 'score')}` : ''}. افتح لوحة التعلم لقراءة الملاحظات.`,
        }
      : {
          subject: 'Your assignment has been graded',
          text: `Your assignment "${str(v, 'assignmentTitle')}" has been graded${str(v, 'score') ? ` with a score of ${str(v, 'score')}` : ''}. Open your learning dashboard to read the feedback.`,
        },
  quiz_attempt_graded: (v) =>
    isArabic(v)
      ? {
          subject: 'اكتمل تقييم اختبارك',
          text: `اكتمل تقييم اختبارك "${str(v, 'quizTitle')}". افتح لوحة التعلم لمشاهدة النتيجة.`,
        }
      : {
          subject: 'Your quiz has been graded',
          text: `Grading of your quiz "${str(v, 'quizTitle')}" is complete. Open your learning dashboard to see the result.`,
        },
  certificate_issued: (v) =>
    isArabic(v)
      ? {
          subject: 'شهادتك جاهزة',
          text: `تهانينا — صدرت شهادة إتمام دورة "${str(v, 'courseTitle')}" من ${str(v, 'academyName')}. يمكنك تنزيلها من قسم الشهادات في لوحة التعلم. رقم التحقق: ${str(v, 'verificationCode')}.`,
        }
      : {
          subject: 'Your certificate is ready',
          text: `Congratulations — your certificate for "${str(v, 'courseTitle')}" from ${str(v, 'academyName')} has been issued. Download it from the Certificates section of your learning dashboard. Verification code: ${str(v, 'verificationCode')}.`,
        },
  certificate_revoked: (v) =>
    isArabic(v)
      ? {
          subject: 'تم إلغاء شهادة',
          text: `تم إلغاء شهادتك لدورة "${str(v, 'courseTitle')}" من ${str(v, 'academyName')}. تواصل مع الأكاديمية إذا كان لديك استفسار.`,
        }
      : {
          subject: 'A certificate was revoked',
          text: `Your certificate for "${str(v, 'courseTitle')}" from ${str(v, 'academyName')} has been revoked. Contact the academy if you have a question about this.`,
        },
  live_session_recording_available: (v) => ({
    subject: 'Your session recording is ready',
    text: `The recording for "${str(v, 'title')}" has finished processing and is now in your academy's media library.`,
  }),
  provisioning_completed: (v) => ({
    subject: 'Your academy is ready',
    text: `Good news — "${str(v, 'academyName')}" has finished provisioning and is ready to use.`,
  }),
  provisioning_failed: (v) => ({
    subject: 'We could not finish setting up your academy',
    text: `We ran into a problem provisioning "${str(v, 'academyName')}". Our team has been notified — please contact support if this persists.`,
  }),
  course_order_paid: (v) => ({
    subject: 'Purchase confirmed',
    text: `Your purchase of "${str(v, 'courseTitle')}" is confirmed. You now have access to the course.`,
  }),
  course_order_payment_failed: (v) => ({
    subject: 'Payment failed',
    text: `Your payment for "${str(v, 'courseTitle')}" could not be completed. Please try again or use a different payment method.`,
  }),
  course_order_refunded: (v) => ({
    subject: 'Refund processed',
    text: `Your purchase of "${str(v, 'courseTitle')}" has been refunded.`,
  }),
  platform_payment_approved: (v) => ({
    subject: 'Payment approved',
    text: `Your payment of ${str(v, 'amount')} ${str(v, 'currency')} has been approved.`,
  }),
  platform_payment_rejected: (v) => ({
    subject: 'Payment rejected',
    text: `Your payment of ${str(v, 'amount')} ${str(v, 'currency')} was rejected.${
      str(v, 'reason') ? ` Reason: ${str(v, 'reason')}` : ''
    }`,
  }),
  support_case_reply: (v) => ({
    subject: `New reply on "${str(v, 'subject')}"`,
    text: `There's a new reply on your support case "${str(v, 'subject')}".`,
  }),
  password_changed: () => ({
    subject: 'Your password was changed',
    text: 'Your Atlas account password was just changed. If this was not you, contact support immediately.',
  }),
};

export function renderEmailTemplate(
  key: EmailTemplateKey,
  values: Record<string, unknown>,
): TemplateBody {
  return TEMPLATES[key](values);
}
