import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * An announcement was published to a course or an academy (plan §8 H1).
 *
 * In-app only today: §10 asks for "preference (engagement) with a
 * per-announcement 'also email' choice for owners, capped (§22)", and no
 * such flag exists on `announcements`. A template is still required —
 * every catalogue key must render in both locales — and this is the copy
 * the email half would use the day the flag exists.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    // The announcement's own title is author-written and cannot be
    // localized, so the LOCALIZED half is the prefix around it.
    subject: (v) => `New announcement: ${str(v, 'title', 'from your academy')}`,
    preheader: (v) => `From ${str(v, 'academyName', 'your academy')}.`,
    paragraphs: (v) => {
      const courseTitle = str(v, 'courseTitle');
      return [
        courseTitle
          ? `${str(v, 'academyName', 'Your academy')} posted an announcement in ${courseTitle}.`
          : `${str(v, 'academyName', 'Your academy')} posted an announcement.`,
        str(v, 'title', 'Open Atlas to read it.'),
      ];
    },
    ctaLabel: 'Read the announcement',
  }),
  ar: defineLocale({
    subject: (v) => `إعلان جديد: ${str(v, 'title', 'من أكاديميتك')}`,
    preheader: (v) => `من ${str(v, 'academyName', 'أكاديميتك')}.`,
    paragraphs: (v) => {
      const courseTitle = str(v, 'courseTitle');
      return [
        courseTitle
          ? `نشرت ${str(v, 'academyName', 'أكاديميتك')} إعلانًا في دورة ${courseTitle}.`
          : `نشرت ${str(v, 'academyName', 'أكاديميتك')} إعلانًا جديدًا.`,
        str(v, 'title', 'افتح أطلس لقراءته.'),
      ];
    },
    ctaLabel: 'قراءة الإعلان',
  }),
};
