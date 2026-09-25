import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * A learner submitted a review and it is waiting for moderation (plan §8
 * F1) — a STAFF work item, not learner news.
 *
 * The catalogue sends it as `email: 'digest'`, which is what makes this
 * copy read the way it does: a moderator on a busy academy would
 * otherwise get one mail per review. Batched, the useful thing is the
 * queue, so the subject counts rather than names, and the body says what
 * to do rather than describing the review.
 *
 * The review body itself is deliberately NOT quoted here. Learner-written
 * text in an outbound email is an injection and abuse surface, and a
 * moderator has to open the queue to act on it regardless.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `A review is waiting for moderation at ${str(v, 'academyName', 'your academy')}`,
    paragraphs: (v) => [
      `A learner reviewed ${str(v, 'courseTitle', 'one of your courses')}. It is not visible to anyone until it is approved.`,
      'Open the moderation queue to approve or reject it.',
    ],
    ctaLabel: 'Open the moderation queue',
  }),
  ar: defineLocale({
    subject: (v) => `مراجعة بانتظار الاعتماد في ${str(v, 'academyName', 'أكاديميتك')}`,
    paragraphs: (v) => [
      `قام أحد المتعلمين بمراجعة ${str(v, 'courseTitle', 'إحدى دوراتك')}. لن تظهر المراجعة لأحد قبل اعتمادها.`,
      'افتح قائمة الاعتماد للموافقة عليها أو رفضها.',
    ],
    ctaLabel: 'فتح قائمة الاعتماد',
  }),
};
