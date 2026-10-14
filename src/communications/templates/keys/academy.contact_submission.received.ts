import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-WEB-05 — a visitor sent a message through the academy website's
 * Contact form. A STAFF work item, sent as `email: 'digest'`.
 *
 * The visitor's name, address and message are deliberately NOT in this
 * email: they are untrusted text from an anonymous form, and the people
 * who may read them do so in the Messages inbox, which the call to
 * action opens.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `New message from the ${str(v, 'academyName', 'academy')} website`,
    paragraphs: () => [
      'Someone sent a message through the Contact form on your academy website.',
      'Open the Messages inbox to read it and reply.',
    ],
    ctaLabel: 'Open Messages',
  }),
  ar: defineLocale({
    subject: (v) => `رسالة جديدة من موقع ${str(v, 'academyName', 'الأكاديمية')}`,
    paragraphs: () => [
      'أرسل أحد الزوار رسالة عبر نموذج التواصل في موقع أكاديميتك.',
      'افتح صندوق الرسائل لقراءتها والرد عليها.',
    ],
    ctaLabel: 'فتح الرسائل',
  }),
};
