import { defineLocale, str } from '../layout';
import type { CommunicationTemplate } from '../layout';

/**
 * §31 K3 — the Platform Owner, when one asset has exhausted its five
 * attempts.
 *
 * Addressed to Atlas, never to the customer: the customer's own D email
 * already states honestly how many files remain. What an operator needs
 * and a customer does not is the asset id and the last error.
 *
 * The sentence that matters is the last one. The asset is still `active`
 * and still playable; the only thing recorded against it is
 * `deletionFailedAt`. Whoever reads this must not assume the bytes are
 * gone.
 */
export const template: CommunicationTemplate = {
  version: '1',
  en: defineLocale({
    subject: (v) => `Video retention: deletion failed for asset ${str(v, 'assetId')}`,
    paragraphs: (v) => [
      `A hosted-video deletion for organisation ${str(v, 'organizationName')} (${str(v, 'organizationId')}) exhausted all ${str(v, 'attempts')} attempts.`,
      `Asset: ${str(v, 'assetId')} — provider ${str(v, 'provider')}, file ${str(v, 'fileName')}.`,
      `Last error: ${str(v, 'lastError', 'unknown')}`,
      'The asset has NOT been tombstoned. Its status is still `active` and only `deletionFailedAt` was written, because the bytes may still exist at the provider. It needs a person: retry it, or confirm at the provider and record the outcome deliberately.',
    ],
    ctaLabel: 'Open platform analytics',
  }),
  ar: defineLocale({
    subject: (v) => `الاحتفاظ بالفيديو: فشل حذف الملف ${str(v, 'assetId')}`,
    paragraphs: (v) => [
      `استنفد حذف فيديو مستضاف للمؤسسة ${str(v, 'organizationName')} (${str(v, 'organizationId')}) جميع المحاولات البالغة ${str(v, 'attempts')}.`,
      `الملف: ${str(v, 'assetId')} — المزوّد ${str(v, 'provider')}، اسم الملف ${str(v, 'fileName')}.`,
      `آخر خطأ: ${str(v, 'lastError', 'غير معروف')}`,
      'لم يُسجَّل الملف كمحذوف. حالته ما زالت `active` ولم يُكتب سوى `deletionFailedAt`، لأن البيانات قد تكون لا تزال موجودة لدى المزوّد. الأمر يحتاج إلى تدخل بشري: إعادة المحاولة، أو التحقق لدى المزوّد وتسجيل النتيجة بشكل مقصود.',
    ],
    ctaLabel: 'فتح تحليلات المنصة',
  }),
};
