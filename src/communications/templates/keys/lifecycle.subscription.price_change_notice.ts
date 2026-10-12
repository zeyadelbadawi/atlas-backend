import { defineLocale, str } from '../layout';
import type { CommunicationTemplate, TemplateValues } from '../layout';

/**
 * B0-BIL-07 — the in-product notice Terms §9 promises before a price or
 * plan-content change applies to an active subscription.
 *
 * What the customer needs is: which plan, the renewal price before and
 * after (for THEIR billing cycle), whether the plan's limits change too,
 * and when it applies — their next renewal, which the producer gives as
 * `renewalDate` (the end of the current paid period). Nothing changes
 * before then, and the email says so, because "your price changed" read
 * alone sounds like a charge.
 *
 * Every value is optional in the copy: no price on either side (a limits-
 * only edit) drops the price sentence; no renewal date drops the date.
 * The full detail is on the subscription page the button opens.
 */

/** U+2066 LEFT-TO-RIGHT ISOLATE … U+2069 POP DIRECTIONAL ISOLATE. */
function ltr(value: string): string {
  return value ? `⁦${value}⁩` : value;
}

function hasLimitChanges(values: TemplateValues): boolean {
  const raw = values.limitChangeCount;
  const count = typeof raw === 'string' ? Number(raw) : raw;
  return typeof count === 'number' && count > 0;
}

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `A change to your ${str(v, 'planName', 'Atlas')} plan at renewal`,
    paragraphs: (v) => {
      const plan = str(v, 'planName', 'Atlas');
      const from = str(v, 'fromPrice');
      const to = str(v, 'toPrice');
      const renewal = str(v, 'renewalDate');
      const when = renewal
        ? `from your next renewal, due ${renewal}`
        : 'from your next renewal';
      return [
        `We have updated the ${plan} plan. Nothing changes for your current paid period: the change applies ${when}.`,
        ...(from && to && from !== to
          ? [`Renewal price: ${from} now, ${to} from your next renewal.`]
          : []),
        ...(to && !from ? [`Renewal price from your next renewal: ${to}.`] : []),
        ...(hasLimitChanges(v)
          ? [
              'The limits included in the plan also change at renewal. Your subscription page shows each one.',
            ]
          : []),
        'If the new terms do not suit you, you can choose another plan before you renew.',
      ];
    },
    ctaLabel: 'View subscription',
  }),
  ar: defineLocale({
    subject: (v) => `تغيير في خطة ${str(v, 'planName', 'أطلس')} عند التجديد`,
    paragraphs: (v) => {
      const plan = str(v, 'planName', 'أطلس');
      const from = ltr(str(v, 'fromPrice'));
      const to = ltr(str(v, 'toPrice'));
      const renewal = ltr(str(v, 'renewalDate'));
      const when = renewal
        ? `من تجديدك القادم المستحق في ${renewal}`
        : 'من تجديدك القادم';
      return [
        `حدّثنا خطة ${plan}. لا يتغير شيء خلال فترتك المدفوعة الحالية، ويسري التغيير ${when}.`,
        ...(from && to && from !== to
          ? [`سعر التجديد: ${from} حاليًا، و${to} من تجديدك القادم.`]
          : []),
        ...(to && !from ? [`سعر التجديد من تجديدك القادم: ${to}.`] : []),
        ...(hasLimitChanges(v)
          ? [
              'تتغير أيضًا الحدود التي تشملها الخطة عند التجديد، وتعرض صفحة اشتراكك كل حد منها.',
            ]
          : []),
        'إذا لم تناسبك الشروط الجديدة، يمكنك اختيار خطة أخرى قبل التجديد.',
      ];
    },
    ctaLabel: 'عرض الاشتراك',
  }),
};
