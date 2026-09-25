import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §31 W3 — the final warning, seven days out, with the exact date and
 * time. The word "final" is in the copy because §31 asks for it and
 * because a reader who skimmed W1 and W2 needs one unambiguous signal that
 * the next email is not another reminder.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) =>
      `Final warning: your hosted videos are deleted on ${str(v, 'deletionAtDate')}`,
    preheader: () => 'This is the last notice before the deletion date.',
    paragraphs: (v) => [
      `This is your final warning. On ${str(v, 'deletionAtDate')} — seven days from now — the ${str(v, 'videoCount')} video file(s) hosted for your academy, about ${str(v, 'videoMinutes')} minutes, will be permanently deleted from our provider and from our storage.`,
      'This cannot be undone and the files cannot be recovered afterwards, by us or by anyone else.',
      'Your courses, lessons, students, enrolments, progress and certificates are not affected and are never deleted for inactivity.',
      'Reactivating your subscription before that date stops the deletion entirely.',
    ],
    ctaLabel: 'Reactivate now',
  }),
  ar: defineLocale({
    subject: (v) => `تحذير أخير: ستُحذف مقاطعك المستضافة في ${str(v, 'deletionAtDate')}`,
    preheader: () => 'هذا هو الإشعار الأخير قبل موعد الحذف.',
    paragraphs: (v) => [
      `هذا تحذيرك الأخير. في ${str(v, 'deletionAtDate')} — بعد سبعة أيام من الآن — ستُحذف نهائيًا ${str(v, 'videoCount')} ملف فيديو مستضاف لأكاديميتك، بما يقارب ${str(v, 'videoMinutes')} دقيقة، من مزوّد الخدمة ومن مساحة التخزين لدينا.`,
      'لا يمكن التراجع عن ذلك، ولا يمكن استرجاع الملفات بعده، لا من قِبلنا ولا من قِبل أي جهة أخرى.',
      'دوراتك ودروسك وطلابك وتسجيلاتهم وتقدّمهم وشهاداتهم غير متأثرة، ولا تُحذف أبدًا بسبب عدم النشاط.',
      'إعادة تفعيل اشتراكك قبل ذلك التاريخ توقف الحذف تمامًا.',
    ],
    ctaLabel: 'إعادة التفعيل الآن',
  }),
};
