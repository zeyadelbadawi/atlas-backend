import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * The end date of a learner's course access moved, or was removed
 * (plan §8 C4). Two genuinely different messages, so the subject branches
 * rather than rendering an empty date.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      str(v, 'expiresAtDate')
        ? `Your access to ${str(v, 'courseTitle', 'a course')} now ends on ${str(v, 'expiresAtDate')}`
        : `Your access to ${str(v, 'courseTitle', 'a course')} no longer expires`,
    paragraphs: (v) => {
      const until = str(v, 'expiresAtDate');
      return until
        ? [
            `${str(v, 'academyName', 'Your academy')} changed the end date of your access to ${str(v, 'courseTitle', 'a course')}.`,
            `You can study this course until ${until}.`,
          ]
        : [
            `${str(v, 'academyName', 'Your academy')} removed the end date on your access to ${str(v, 'courseTitle', 'a course')}.`,
            'Your access no longer expires.',
          ];
    },
    ctaLabel: 'Open the course',
  }),
  ar: defineLocale({
    subject: (v) =>
      str(v, 'expiresAtDate')
        ? `ينتهي وصولك إلى ${str(v, 'courseTitle', 'إحدى الدورات')} في ${str(v, 'expiresAtDate')}`
        : `لم يعد لوصولك إلى ${str(v, 'courseTitle', 'إحدى الدورات')} تاريخ انتهاء`,
    paragraphs: (v) => {
      const until = str(v, 'expiresAtDate');
      return until
        ? [
            `غيّرت ${str(v, 'academyName', 'أكاديميتك')} تاريخ انتهاء وصولك إلى ${str(v, 'courseTitle', 'إحدى الدورات')}.`,
            `يمكنك دراسة هذه الدورة حتى ${until}.`,
          ]
        : [
            `أزالت ${str(v, 'academyName', 'أكاديميتك')} تاريخ انتهاء وصولك إلى ${str(v, 'courseTitle', 'إحدى الدورات')}.`,
            'لم يعد لوصولك تاريخ انتهاء.',
          ];
    },
    ctaLabel: 'فتح الدورة',
  }),
};
