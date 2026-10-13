import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import { limitAmount, limitLabel } from '../billing-limit-labels';

/**
 * B0-BIL-13 — the organization is at 80 % or more of a plan limit. Limits
 * are hard: at 100 % new additions are refused, so this is the owner's
 * chance to upgrade first.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `You're close to your ${limitLabel('en', str(v, 'limitKey'))} limit`,
    paragraphs: (v) => [
      `You're using ${limitAmount('en', str(v, 'limitKey'), str(v, 'used'), str(v, 'limit'))} ${limitLabel('en', str(v, 'limitKey'))} included in your plan.`,
      'When you reach the limit, new additions are refused until you upgrade your plan.',
    ],
    ctaLabel: 'Compare plans',
  }),
  ar: defineLocale({
    subject: (v) => `اقتربت من حد ${limitLabel('ar', str(v, 'limitKey'))} في خطتك`,
    paragraphs: (v) => [
      `تستخدم ${limitAmount('ar', str(v, 'limitKey'), str(v, 'used'), str(v, 'limit'))} من ${limitLabel('ar', str(v, 'limitKey'))} المتاحة في خطتك.`,
      'عند الوصول إلى الحد، تُرفض الإضافات الجديدة إلى أن تُرقّي خطتك.',
    ],
    ctaLabel: 'مقارنة الخطط',
  }),
};
