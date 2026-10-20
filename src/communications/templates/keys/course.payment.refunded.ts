import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * Academy Manual Payments — the Client Owner recorded that the academy
 * refunded the learner's approved payment. The money moved outside Atlas
 * (the academy sent it back), so the email reports what the ACADEMY
 * recorded and tells the learner to contact the academy if it has not
 * arrived — never that Atlas refunded anything. The note is the owner's
 * own text, optional; the layout escapes it. Sent once per payment.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Refund recorded: ${str(v, 'courseTitle', 'your course')}`,
    preheader: () => 'The academy recorded a refund of your payment.',
    paragraphs: (v) => {
      const lines = [
        `The academy recorded that it refunded your payment of ${str(v, 'amount')} ${str(v, 'currency')} for "${str(v, 'courseTitle', 'your course')}". Your access to the course has ended.`,
      ];
      const note = str(v, 'note');
      if (note) lines.push(`Note from the academy: ${note}`);
      lines.push(
        'The academy returns the money itself, outside Atlas. If it has not reached you, contact the academy.',
      );
      return lines;
    },
    ctaLabel: 'View my purchases',
  }),
  ar: defineLocale({
    subject: (v) => `تم تسجيل استرداد: ${str(v, 'courseTitle', 'دورتك')}`,
    preheader: () => 'سجّلت الأكاديمية استرداد دفعتك.',
    paragraphs: (v) => {
      const lines = [
        `سجّلت الأكاديمية أنها ردّت إليك دفعتك بقيمة ${str(v, 'amount')} ${str(v, 'currency')} لدورة "${str(v, 'courseTitle', 'دورتك')}". انتهى وصولك إلى الدورة.`,
      ];
      const note = str(v, 'note');
      if (note) lines.push(`ملاحظة من الأكاديمية: ${note}`);
      lines.push(
        'تعيد الأكاديمية المبلغ بنفسها خارج أطلس. إذا لم يصلك، تواصل مع الأكاديمية.',
      );
      return lines;
    },
    ctaLabel: 'عرض مشترياتي',
  }),
};
