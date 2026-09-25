import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * Someone signed up to an academy whose registration policy is
 * `approval`, and is waiting (plan §8 G1) — a STAFF work item.
 *
 * The person is blocked until somebody acts, which is why this exists at
 * all: without it a learner sits in `pending` indefinitely and the only
 * way anyone finds out is if they complain. Batched as a digest, because
 * an academy running an intake week would otherwise get one mail per
 * signup.
 *
 * The learner's name and address are deliberately NOT in the copy. The
 * roster page shows them to someone who is authorised to see them; an
 * email is forwardable, and this one only needs to say that the queue is
 * not empty.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Someone is waiting to join ${str(v, 'academyName', 'your academy')}`,
    paragraphs: () => [
      'A new learner signed up and is waiting for approval. They cannot reach any course until someone approves them.',
      'Open the roster to approve or decline.',
    ],
    ctaLabel: 'Open the roster',
  }),
  ar: defineLocale({
    subject: (v) => `هناك من ينتظر الانضمام إلى ${str(v, 'academyName', 'أكاديميتك')}`,
    paragraphs: () => [
      'سجّل متعلم جديد وهو بانتظار الموافقة. لا يمكنه الوصول إلى أي دورة قبل أن يوافق عليه أحد.',
      'افتح قائمة المتعلمين للموافقة أو الرفض.',
    ],
    ctaLabel: 'فتح قائمة المتعلمين',
  }),
};
