import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §31 W2 — the reminder, fourteen days out, "same, with the list of
 * affected courses".
 *
 * The course list is staff-authored content going back to the person who
 * authored it, which is why it is included here where C3's rule ("never
 * quote user-written content in outbound mail") kept a learner's review
 * text out. It is still escaped by the layout, and the service caps how
 * many titles it passes so a large academy does not receive an email
 * hundreds of lines long.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `14 days left: your hosted videos are deleted on ${str(v, 'deletionAtDate')}`,
    preheader: () => 'The courses affected are listed below.',
    paragraphs: (v) => [
      `On ${str(v, 'deletionAtDate')} we will permanently delete the ${str(v, 'videoCount')} video file(s) hosted for your academy — about ${str(v, 'videoMinutes')} minutes in total.`,
      `Courses affected: ${str(v, 'courseList', '—')}`,
      'Everything that is not a hosted video file stays: the courses themselves, their lessons and text, your students, their progress and their certificates.',
      'Reactivating your subscription stops this immediately. You can also download your videos until the date above.',
    ],
    ctaLabel: 'Keep my videos',
  }),
  ar: defineLocale({
    subject: (v) =>
      `بقي 14 يومًا: ستُحذف مقاطعك المستضافة في ${str(v, 'deletionAtDate')}`,
    preheader: () => 'الدورات المتأثرة مذكورة أدناه.',
    paragraphs: (v) => [
      `في ${str(v, 'deletionAtDate')} سنحذف نهائيًا ${str(v, 'videoCount')} ملف فيديو مستضاف لأكاديميتك، بما يقارب ${str(v, 'videoMinutes')} دقيقة إجمالًا.`,
      `الدورات المتأثرة: ${str(v, 'courseList', '—')}`,
      'كل ما ليس ملف فيديو مستضافًا يبقى كما هو: الدورات نفسها ودروسها ونصوصها، وطلابك وتقدّمهم وشهاداتهم.',
      'إعادة تفعيل اشتراكك توقف ذلك فورًا. ويمكنك أيضًا تنزيل مقاطعك حتى التاريخ أعلاه.',
    ],
    ctaLabel: 'الاحتفاظ بمقاطعي',
  }),
};
