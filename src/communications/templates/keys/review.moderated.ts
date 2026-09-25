import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * A course review was approved or rejected by a moderator (plan §8 F2).
 * The catalogue sets `email: 'never'` — this copy exists because the
 * registry requires a template for every key and because the in-app row
 * renders from the same copy if the channel policy ever changes.
 */
function approved(values: Record<string, unknown>): boolean {
  return str(values, 'status') === 'approved';
}

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      approved(v)
        ? `Your review of ${str(v, 'courseTitle', 'a course')} is now published`
        : `Your review of ${str(v, 'courseTitle', 'a course')} was not published`,
    paragraphs: (v) =>
      approved(v)
        ? [
            `A moderator at ${str(v, 'academyName', 'the academy')} approved your review of ${str(v, 'courseTitle', 'a course')}. Other learners can see it now.`,
          ]
        : [
            `A moderator at ${str(v, 'academyName', 'the academy')} did not publish your review of ${str(v, 'courseTitle', 'a course')}.`,
            'You can edit and submit it again at any time.',
          ],
    ctaLabel: 'Open the course',
  }),
  ar: defineLocale({
    subject: (v) =>
      approved(v)
        ? `تم نشر مراجعتك لدورة ${str(v, 'courseTitle', 'إحدى الدورات')}`
        : `لم يتم نشر مراجعتك لدورة ${str(v, 'courseTitle', 'إحدى الدورات')}`,
    paragraphs: (v) =>
      approved(v)
        ? [
            `وافق أحد المشرفين في ${str(v, 'academyName', 'الأكاديمية')} على مراجعتك لدورة ${str(v, 'courseTitle', 'إحدى الدورات')}، وأصبحت ظاهرة لبقية المتعلمين.`,
          ]
        : [
            `لم ينشر المشرف في ${str(v, 'academyName', 'الأكاديمية')} مراجعتك لدورة ${str(v, 'courseTitle', 'إحدى الدورات')}.`,
            'يمكنك تعديلها وإرسالها من جديد في أي وقت.',
          ],
    ctaLabel: 'فتح الدورة',
  }),
};
