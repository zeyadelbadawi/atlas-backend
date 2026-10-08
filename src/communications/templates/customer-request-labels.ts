/**
 * Customer Requests — the request type and status names emails print, in
 * both locales. Unknown raw values are printed as they are rather than
 * guessed at.
 */
const TYPE: Record<'en' | 'ar', Record<string, string>> = {
  en: {
    logo: 'Logo design',
    domain: 'Custom domain',
    theme: 'Custom theme',
    custom_section: 'Custom website section',
    custom_feature: 'Custom feature',
  },
  ar: {
    logo: 'تصميم شعار',
    domain: 'نطاق مخصص',
    theme: 'تصميم مخصص',
    custom_section: 'قسم مخصص للموقع',
    custom_feature: 'ميزة مخصصة',
  },
};

const STATUS: Record<'en' | 'ar', Record<string, string>> = {
  en: {
    submitted: 'Submitted',
    received: 'Received',
    under_review: 'Under review',
    in_progress: 'In progress',
    waiting_for_customer: 'Waiting for your reply',
    completed: 'Completed',
    rejected: 'Declined',
    cancelled: 'Cancelled',
  },
  ar: {
    submitted: 'تم الإرسال',
    received: 'تم الاستلام',
    under_review: 'قيد المراجعة',
    in_progress: 'قيد التنفيذ',
    waiting_for_customer: 'بانتظار ردك',
    completed: 'مكتمل',
    rejected: 'مرفوض',
    cancelled: 'ملغى',
  },
};

export function requestTypeLabel(locale: 'en' | 'ar', raw: string): string {
  return TYPE[locale][raw] ?? raw;
}

export function requestStatusLabel(locale: 'en' | 'ar', raw: string): string {
  return STATUS[locale][raw] ?? raw;
}
