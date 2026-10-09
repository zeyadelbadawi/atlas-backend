import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';
import { requestStatusLabel } from '../customer-request-labels';

/** Customer Requests — to the requester: the team moved the request to a new status. */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `Request update — ${str(v, 'title')}: ${requestStatusLabel('en', str(v, 'status'))}`,
    paragraphs: (v) => [
      `Your request "${str(v, 'title')}" is now: ${requestStatusLabel('en', str(v, 'status'))}.`,
      str(v, 'status') === 'waiting_for_customer'
        ? 'The team needs more information from you. Open the request to reply.'
        : 'Open the request to see its history and any messages from the team.',
    ],
    ctaLabel: 'View request',
  }),
  ar: defineLocale({
    subject: (v) =>
      `تحديث الطلب — ${str(v, 'title')}: ${requestStatusLabel('ar', str(v, 'status'))}`,
    paragraphs: (v) => [
      `أصبحت حالة طلبك "${str(v, 'title')}": ${requestStatusLabel('ar', str(v, 'status'))}.`,
      str(v, 'status') === 'waiting_for_customer'
        ? 'يحتاج الفريق إلى معلومات إضافية منك. افتح الطلب للرد.'
        : 'افتح الطلب لمشاهدة سجله وأي رسائل من الفريق.',
    ],
    ctaLabel: 'عرض الطلب',
  }),
};
