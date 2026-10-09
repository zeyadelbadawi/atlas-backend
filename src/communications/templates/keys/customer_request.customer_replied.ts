import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** Customer Requests — the academy answered (feed of the assigned Platform Owner). */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Customer replied: ${str(v, 'title')}`,
    paragraphs: (v) => [
      `${str(v, 'academyName')} replied on "${str(v, 'title')}".`,
      str(v, 'excerpt'),
    ],
    ctaLabel: 'Open request',
  }),
  ar: defineLocale({
    subject: (v) => `رد العميل: ${str(v, 'title')}`,
    paragraphs: (v) => [
      `ردت ${str(v, 'academyName')} على "${str(v, 'title')}".`,
      str(v, 'excerpt'),
    ],
    ctaLabel: 'فتح الطلب',
  }),
};
