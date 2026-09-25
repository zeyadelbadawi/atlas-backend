import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §27 S8 — the confirmation a cancelling customer is owed. The effective
 * date matters more than the word "cancelled": cancelling never forfeits
 * time already paid for, and saying so removes the most common support
 * question this action generates.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your subscription is set to end',
    paragraphs: (v) => [
      `We have recorded your cancellation. Your subscription stays fully active until ${str(v, 'effectiveAtDate')} — you keep every day you have paid for.`,
      'Nothing changes before that date. If you change your mind, renewing before then keeps everything running without a break.',
    ],
    ctaLabel: 'View subscription',
  }),
  ar: defineLocale({
    subject: () => 'تم جدولة إنهاء اشتراكك',
    paragraphs: (v) => [
      `سجّلنا طلب الإلغاء. يبقى اشتراكك فعّالًا بالكامل حتى ${str(v, 'effectiveAtDate')}، فأنت تحتفظ بكل يوم دفعت مقابله.`,
      'لن يتغير شيء قبل ذلك التاريخ. وإذا غيّرت رأيك، فإن التجديد قبله يبقي كل شيء يعمل دون انقطاع.',
    ],
    ctaLabel: 'عرض الاشتراك',
  }),
};
