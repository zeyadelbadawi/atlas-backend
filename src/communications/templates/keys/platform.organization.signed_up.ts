import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B0-SUP-01 — a new organization signed up. Platform Owners only. Whether
 * a trial started is the producer's decision (`trialStarted`); the owner's
 * contact details stay on the organization record.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `New organization: ${str(v, 'organizationName', 'a new customer')}`,
    preheader: () => 'A new organization signed up.',
    paragraphs: (v) => [
      `${str(v, 'organizationName', 'A new organization')} signed up for Atlas.`,
      v.trialStarted === true
        ? 'Its trial has started.'
        : 'No trial was started for this organization.',
    ],
    ctaLabel: 'View organization',
  }),
  ar: defineLocale({
    subject: (v) => `مؤسسة جديدة: ${str(v, 'organizationName', 'عميل جديد')}`,
    preheader: () => 'سجّلت مؤسسة جديدة.',
    paragraphs: (v) => [
      `سجّلت ${str(v, 'organizationName', 'مؤسسة جديدة')} في Atlas.`,
      v.trialStarted === true
        ? 'بدأت فترتها التجريبية.'
        : 'لم تبدأ فترة تجريبية لهذه المؤسسة.',
    ],
    ctaLabel: 'عرض المؤسسة',
  }),
};
