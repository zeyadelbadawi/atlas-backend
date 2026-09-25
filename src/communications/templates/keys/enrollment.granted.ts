import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** Course access granted by academy staff (plan §8 C2). */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `You have been enrolled in ${str(v, 'courseTitle', 'a course')}`,
    preheader: (v) => `${str(v, 'courseTitle', 'Your course')} is now open to you.`,
    paragraphs: (v) => {
      const lines = [
        `${str(v, 'academyName', 'Your academy')} has enrolled you in ${str(v, 'courseTitle', 'a course')}. You can start straight away.`,
      ];
      const until = str(v, 'expiresAtDate');
      if (until) lines.push(`Your access to this course runs until ${until}.`);
      return lines;
    },
    ctaLabel: 'Open the course',
  }),
  ar: defineLocale({
    subject: (v) => `تم تسجيلك في ${str(v, 'courseTitle', 'دورة جديدة')}`,
    preheader: (v) => `${str(v, 'courseTitle', 'دورتك')} متاحة لك الآن.`,
    paragraphs: (v) => {
      const lines = [
        `قامت ${str(v, 'academyName', 'أكاديميتك')} بتسجيلك في ${str(v, 'courseTitle', 'دورة جديدة')}. يمكنك البدء فورًا.`,
      ];
      const until = str(v, 'expiresAtDate');
      if (until) lines.push(`يستمر وصولك إلى هذه الدورة حتى ${until}.`);
      return lines;
    },
    ctaLabel: 'فتح الدورة',
  }),
};
