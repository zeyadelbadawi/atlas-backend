import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §31 W1 — the first notice, thirty days out.
 *
 * Says WHAT goes (hosted video only), HOW MUCH (count, minutes, courses),
 * WHEN, and the two ways to stop it. It is equally careful to say what is
 * NOT deleted, because the fear this email creates is "am I losing my
 * academy" and the true answer is no — courses, students, progress and
 * certificates all stay.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Your hosted videos will be deleted on ${str(v, 'deletionAtDate')}`,
    preheader: () => 'Your courses and students stay. Only the video files go.',
    paragraphs: (v) => [
      `Your subscription has been inactive since ${str(v, 'anchorAtDate')}. In 30 days, on ${str(v, 'deletionAtDate')}, we will permanently delete the video files hosted for your academy.`,
      `That is ${str(v, 'videoCount')} video file(s), about ${str(v, 'videoMinutes')} minutes, across ${str(v, 'courseCount')} course(s).`,
      'Nothing else is deleted. Your academy, courses, lessons, students, enrolments, progress, certificates and documents all stay exactly as they are, and reactivating restores all of them.',
      'There are two ways to stop this: choose a plan to reactivate your subscription, or download your videos before the date above. Deleted video cannot be restored.',
    ],
    ctaLabel: 'Keep my videos',
  }),
  ar: defineLocale({
    subject: (v) =>
      `سيتم حذف مقاطع الفيديو المستضافة لديك في ${str(v, 'deletionAtDate')}`,
    preheader: () => 'دوراتك وطلابك يبقون كما هم. تُحذف ملفات الفيديو فقط.',
    paragraphs: (v) => [
      `اشتراكك غير مفعّل منذ ${str(v, 'anchorAtDate')}. بعد 30 يومًا، في ${str(v, 'deletionAtDate')}، سنحذف نهائيًا ملفات الفيديو المستضافة لأكاديميتك.`,
      `وهي ${str(v, 'videoCount')} ملف فيديو، بما يقارب ${str(v, 'videoMinutes')} دقيقة، ضمن ${str(v, 'courseCount')} دورة.`,
      'لن يُحذف أي شيء آخر. أكاديميتك ودوراتك ودروسك وطلابك وتسجيلاتهم وتقدّمهم وشهاداتهم ومستنداتك تبقى كما هي تمامًا، وإعادة التفعيل تستعيدها جميعًا.',
      'أمامك طريقتان لإيقاف ذلك: اختيار خطة لإعادة تفعيل اشتراكك، أو تنزيل مقاطعك قبل التاريخ أعلاه. لا يمكن استرجاع الفيديو بعد حذفه.',
    ],
    ctaLabel: 'الاحتفاظ بمقاطعي',
  }),
};
