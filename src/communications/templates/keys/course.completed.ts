import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** The learner met the course's completion rule (plan §8 E6). */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `You finished ${str(v, 'courseTitle', 'your course')}`,
    preheader: (v) => `${str(v, 'courseTitle', 'Your course')} is complete.`,
    paragraphs: (v) => {
      const lines = [
        `You have completed ${str(v, 'courseTitle', 'your course')}. Well done.`,
      ];
      const score = str(v, 'overallScore');
      if (score) lines.push(`Your overall score is ${score}%.`);
      lines.push(
        'The course stays in My Courses, so you can go back over it whenever you like.',
      );
      return lines;
    },
    ctaLabel: 'Open the course',
  }),
  ar: defineLocale({
    subject: (v) => `لقد أنهيت ${str(v, 'courseTitle', 'دورتك')}`,
    preheader: (v) => `اكتملت ${str(v, 'courseTitle', 'دورتك')}.`,
    paragraphs: (v) => {
      const lines = [`لقد أكملت ${str(v, 'courseTitle', 'دورتك')}. أحسنت.`];
      const score = str(v, 'overallScore');
      if (score) lines.push(`درجتك الإجمالية هي ${score}٪.`);
      lines.push('تبقى الدورة في قائمة دوراتي، ويمكنك الرجوع إليها متى شئت.');
      return lines;
    },
    ctaLabel: 'فتح الدورة',
  }),
};
