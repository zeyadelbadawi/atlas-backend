import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §31 D — one email per tenant, once every asset of the run has settled.
 *
 * HONEST ABOUT PARTIAL FAILURE, which is the whole reason this is a
 * tenant-level job rather than a line at the end of the last asset job.
 * When the provider refused some of the deletions, those files are still
 * there and their rows still say `active` — and telling the customer
 * "your videos have been deleted" would be false in a way they could
 * later discover by pressing play. The failure branch says exactly how
 * many remain and that Atlas is still working on them.
 *
 * It also repeats, deliberately, what was kept. This email arrives after
 * an irreversible act, and "your courses and students are untouched" is
 * the sentence the reader most needs and least expects.
 */
function failedCount(values: Record<string, unknown>): number {
  const value = Number(values.failedCount ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: () => 'Your hosted videos have been deleted',
    paragraphs: (v) => {
      const failed = failedCount(v);
      return [
        `As we warned on four occasions, the video files hosted for your academy have now been deleted. ${str(v, 'deletedCount')} file(s), about ${str(v, 'deletedMinutes')} minutes, were permanently removed on ${str(v, 'deletedAtDate')}.`,
        ...(failed > 0
          ? [
              `${failed} file(s) could not be deleted and are still stored. We are retrying those, and they will be removed in a later pass — nothing about them has been marked as deleted that was not.`,
            ]
          : []),
        'This is permanent. The files cannot be recovered, by us or by anyone else.',
        'Everything else was kept: your academy, courses, lessons, students, enrolments, progress, certificates, orders and documents. Reactivating your subscription restores all of it — the lessons whose video was removed will say so rather than showing a broken player.',
      ];
    },
    ctaLabel: 'View my academy',
  }),
  ar: defineLocale({
    subject: () => 'تم حذف مقاطع الفيديو المستضافة لديك',
    paragraphs: (v) => {
      const failed = failedCount(v);
      return [
        `كما نبّهناك أربع مرات، حُذفت الآن ملفات الفيديو المستضافة لأكاديميتك. تمت الإزالة النهائية لـ ${str(v, 'deletedCount')} ملف، بما يقارب ${str(v, 'deletedMinutes')} دقيقة، في ${str(v, 'deletedAtDate')}.`,
        ...(failed > 0
          ? [
              `تعذّر حذف ${failed} ملف ولا تزال مخزّنة. نعيد المحاولة عليها وستُزال في جولة لاحقة، ولم يُسجَّل أي ملف على أنه محذوف دون أن يكون كذلك فعلًا.`,
            ]
          : []),
        'هذا الإجراء نهائي. لا يمكن استرجاع الملفات، لا من قِبلنا ولا من قِبل أي جهة أخرى.',
        'وقد احتُفظ بكل ما عدا ذلك: أكاديميتك ودوراتك ودروسك وطلابك وتسجيلاتهم وتقدّمهم وشهاداتهم وطلباتهم ومستنداتك. وإعادة تفعيل اشتراكك تستعيدها جميعًا، والدروس التي أُزيل فيديوها ستوضّح ذلك بدل إظهار مشغّل معطّل.',
      ];
    },
    ctaLabel: 'عرض أكاديميتي',
  }),
};
