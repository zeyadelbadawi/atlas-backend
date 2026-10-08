import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import { requestTypeLabel } from '../customer-request-labels';

/**
 * Customer Requests — to the TEAM INBOX configured for the request type.
 * `event` is `created` (a new request) or `customer_message` (the academy
 * answered). Every value is the customer's own text: the layout escapes it.
 * The call to action opens the request in the Platform Owner console, which
 * requires a Platform Owner session — the email itself grants nothing.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      str(v, 'event') === 'customer_message'
        ? `Customer replied: ${str(v, 'title')} (${str(v, 'academyName')})`
        : `New ${requestTypeLabel('en', str(v, 'type'))} request: ${str(v, 'title')}`,
    paragraphs: (v) =>
      str(v, 'event') === 'customer_message'
        ? [
            `${str(v, 'requesterName')} from ${str(v, 'academyName')} replied on the request "${str(v, 'title')}".`,
            str(v, 'excerpt'),
            'Open the request to read the conversation and answer.',
          ]
        : [
            `${str(v, 'academyName')} requested: ${requestTypeLabel('en', str(v, 'type'))}.`,
            `Title: ${str(v, 'title')}. Priority: ${str(v, 'priority')}. Requested by ${str(v, 'requesterName')} (${str(v, 'requesterEmail')}).`,
            str(v, 'excerpt'),
            'Open the request to review the details, assign it and reply.',
          ],
    ctaLabel: 'Open request',
  }),
  ar: defineLocale({
    subject: (v) =>
      str(v, 'event') === 'customer_message'
        ? `رد العميل: ${str(v, 'title')} (${str(v, 'academyName')})`
        : `طلب جديد (${requestTypeLabel('ar', str(v, 'type'))}): ${str(v, 'title')}`,
    paragraphs: (v) =>
      str(v, 'event') === 'customer_message'
        ? [
            `رد ${str(v, 'requesterName')} من ${str(v, 'academyName')} على الطلب "${str(v, 'title')}".`,
            str(v, 'excerpt'),
            'افتح الطلب لقراءة المحادثة والرد.',
          ]
        : [
            `طلبت ${str(v, 'academyName')}: ${requestTypeLabel('ar', str(v, 'type'))}.`,
            `العنوان: ${str(v, 'title')}. الأولوية: ${str(v, 'priority')}. مقدم الطلب: ${str(v, 'requesterName')} (${str(v, 'requesterEmail')}).`,
            str(v, 'excerpt'),
            'افتح الطلب لمراجعة التفاصيل وتعيينه والرد.',
          ],
    ctaLabel: 'فتح الطلب',
  }),
};
