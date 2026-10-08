import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import { requestTypeLabel } from '../customer-request-labels';

/** Customer Requests — to the requester: the request is in, and what happens next. */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `We received your request: ${str(v, 'title')}`,
    paragraphs: (v) => [
      `Thank you — your ${requestTypeLabel('en', str(v, 'type')).toLowerCase()} request "${str(v, 'title')}" has reached the Atlas team.`,
      'We will review it and reply in your dashboard. You will get an email whenever its status changes or we need more information from you.',
    ],
    ctaLabel: 'View request',
  }),
  ar: defineLocale({
    subject: (v) => `استلمنا طلبك: ${str(v, 'title')}`,
    paragraphs: (v) => [
      `شكرًا لك — وصل طلبك (${requestTypeLabel('ar', str(v, 'type'))}) "${str(v, 'title')}" إلى فريق Atlas.`,
      'سنراجعه ونرد عليك في لوحة التحكم، وستصلك رسالة كلما تغيّرت حالته أو احتجنا منك إلى معلومات إضافية.',
    ],
    ctaLabel: 'عرض الطلب',
  }),
};
