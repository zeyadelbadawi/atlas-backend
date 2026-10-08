import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import { requestTypeLabel } from '../customer-request-labels';

/** Customer Requests — a new request, for the Platform Owner feed (in-app; the email copy exists for completeness). */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `New customer request: ${str(v, 'title')}`,
    paragraphs: (v) => [
      `${str(v, 'academyName')} requested: ${requestTypeLabel('en', str(v, 'type'))} — "${str(v, 'title')}".`,
    ],
    ctaLabel: 'Open request',
  }),
  ar: defineLocale({
    subject: (v) => `طلب عميل جديد: ${str(v, 'title')}`,
    paragraphs: (v) => [
      `طلبت ${str(v, 'academyName')}: ${requestTypeLabel('ar', str(v, 'type'))} — "${str(v, 'title')}".`,
    ],
    ctaLabel: 'فتح الطلب',
  }),
};
