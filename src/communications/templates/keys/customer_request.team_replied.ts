import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** Customer Requests — to the requester: a message from the Atlas team. */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `New message about your request: ${str(v, 'title')}`,
    paragraphs: (v) => [
      `The Atlas team replied on your request "${str(v, 'title')}".`,
      str(v, 'excerpt'),
      'Open the request to read the full message and reply.',
    ],
    ctaLabel: 'View request',
  }),
  ar: defineLocale({
    subject: (v) => `رسالة جديدة بخصوص طلبك: ${str(v, 'title')}`,
    paragraphs: (v) => [
      `رد فريق Atlas على طلبك "${str(v, 'title')}".`,
      str(v, 'excerpt'),
      'افتح الطلب لقراءة الرسالة كاملة والرد.',
    ],
    ctaLabel: 'عرض الطلب',
  }),
};
