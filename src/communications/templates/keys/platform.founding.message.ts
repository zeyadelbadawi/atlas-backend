import { defineLocale, str } from '../layout';
import type { TemplateValues } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * B2 — a message from the Atlas team to Founding Academy owners, written
 * by a Platform Owner in both languages (`FoundingMembershipsService
 * .sendEmail`). Each recipient gets their own language's subject and body;
 * the body is plain text (escaped by the layout), one paragraph per blank
 * line. Programme messages only (setup scheduling, the price lock), never
 * marketing: the composer says so and every send is audited.
 */
function paragraphs(values: TemplateValues, key: string): string[] {
  return str(values, key)
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/\s*\r?\n\s*/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
}

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      str(v, 'subjectEn', 'A message about your Founding Academy membership'),
    paragraphs: (v) => paragraphs(v, 'bodyEn'),
    ctaLabel: 'Open my plan',
  }),
  ar: defineLocale({
    subject: (v) => str(v, 'subjectAr', 'رسالة بخصوص عضويتك في الأكاديميات المؤسِّسة'),
    paragraphs: (v) => paragraphs(v, 'bodyAr'),
    ctaLabel: 'افتح باقتي',
  }),
};
