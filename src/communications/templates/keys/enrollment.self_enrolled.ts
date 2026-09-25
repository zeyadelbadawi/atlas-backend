import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/** The learner enrolled themselves in a free course (plan §8 C1). */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `You are enrolled in ${str(v, 'courseTitle', 'your course')}`,
    preheader: (v) => `${str(v, 'courseTitle', 'Your course')} is open to you now.`,
    paragraphs: (v) => [
      `You enrolled yourself in ${str(v, 'courseTitle', 'a course')} at ${str(v, 'academyName', 'your academy')}. It is open to you now, and it stays in My Courses.`,
      'Nothing is owed for this course — it is free.',
    ],
    ctaLabel: 'Start learning',
  }),
  ar: defineLocale({
    subject: (v) => `تم تسجيلك في ${str(v, 'courseTitle', 'دورتك')}`,
    preheader: (v) => `${str(v, 'courseTitle', 'دورتك')} متاحة لك الآن.`,
    paragraphs: (v) => [
      `قمت بتسجيل نفسك في ${str(v, 'courseTitle', 'دورة')} لدى ${str(v, 'academyName', 'أكاديميتك')}. الدورة متاحة لك الآن وستبقى في قائمة دوراتي.`,
      'لا توجد أي مستحقات على هذه الدورة — فهي مجانية.',
    ],
    ctaLabel: 'ابدأ التعلم',
  }),
};
