import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import { limitAmount, limitLabel } from '../billing-limit-labels';

/**
 * B0-BIL-13 — the organization has reached a plan limit; new additions of
 * that kind are refused until the plan changes.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `You've reached your ${limitLabel('en', str(v, 'limitKey'))} limit`,
    paragraphs: (v) => [
      `You're using ${limitAmount('en', str(v, 'limitKey'), str(v, 'used'), str(v, 'limit'))} ${limitLabel('en', str(v, 'limitKey'))} included in your plan.`,
      'New additions are refused until you upgrade your plan. Everything you already have keeps working.',
    ],
    ctaLabel: 'Upgrade plan',
  }),
  ar: defineLocale({
    subject: (v) => `وصلت إلى حد ${limitLabel('ar', str(v, 'limitKey'))} في خطتك`,
    paragraphs: (v) => [
      `تستخدم ${limitAmount('ar', str(v, 'limitKey'), str(v, 'used'), str(v, 'limit'))} من ${limitLabel('ar', str(v, 'limitKey'))} المتاحة في خطتك.`,
      'تُرفض الإضافات الجديدة إلى أن تُرقّي خطتك. يستمر كل ما لديك حاليًا في العمل.',
    ],
    ctaLabel: 'ترقية الخطة',
  }),
};
