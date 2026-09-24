import { defineLocale } from '../layout';
import type { CommunicationTemplate } from '../layout';

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your live-session provider was disconnected',
    paragraphs: () => [
      'The provider connection used for live sessions was revoked. Scheduled sessions cannot be hosted until it is reconnected.',
    ],
    ctaLabel: 'Reconnect',
  }),
  ar: defineLocale({
    subject: () => 'تم فصل مزوّد الجلسات المباشرة',
    paragraphs: () => [
      'تم إلغاء الاتصال بمزوّد الجلسات المباشرة. لا يمكن استضافة الجلسات المجدولة حتى تتم إعادة الاتصال.',
    ],
    ctaLabel: 'إعادة الاتصال',
  }),
};
