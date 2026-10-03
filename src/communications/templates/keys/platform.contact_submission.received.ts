import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * TASK 7 — a visitor sent the Atlas marketing homepage's contact form.
 *
 * Addressed to Platform Owners only. Every value is the visitor's own,
 * untrusted text: the layout escapes it for HTML, and nothing here is ever
 * interpreted as markup or a link. The message is an excerpt (the producer
 * caps it); the full enquiry is in the Platform Owner's inbox, which the
 * call to action opens. No reply-to is set on the visitor's behalf — an
 * operator answers deliberately from the inbox.
 */
const TOPIC_EN: Record<string, string> = {
  sales: 'Sales',
  support: 'Support',
  partnership: 'Partnership',
  other: 'Other',
};

const TOPIC_AR: Record<string, string> = {
  sales: 'المبيعات',
  support: 'الدعم',
  partnership: 'الشراكات',
  other: 'أخرى',
};

function topic(labels: Record<string, string>, raw: string): string {
  return labels[raw] ?? raw;
}

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `New contact enquiry (${topic(TOPIC_EN, str(v, 'topic'))}) from ${str(v, 'name')}`,
    paragraphs: (v) => [
      `${str(v, 'name')} (${str(v, 'email')}) sent a message through the Atlas website contact form.`,
      `Topic: ${topic(TOPIC_EN, str(v, 'topic'))}. Organization: ${str(v, 'organizationName', 'not provided')}.`,
      str(v, 'message'),
      'Open the inbox to read the full enquiry and mark it handled.',
    ],
    ctaLabel: 'Open contact inbox',
  }),
  ar: defineLocale({
    subject: (v) =>
      `استفسار جديد (${topic(TOPIC_AR, str(v, 'topic'))}) من ${str(v, 'name')}`,
    paragraphs: (v) => [
      `أرسل ${str(v, 'name')} (${str(v, 'email')}) رسالة عبر نموذج التواصل في موقع Atlas.`,
      `الموضوع: ${topic(TOPIC_AR, str(v, 'topic'))}. المؤسسة: ${str(v, 'organizationName', 'غير محددة')}.`,
      str(v, 'message'),
      'افتح صندوق الوارد لقراءة الاستفسار كاملًا وتحديد حالته.',
    ],
    ctaLabel: 'فتح صندوق رسائل التواصل',
  }),
};
