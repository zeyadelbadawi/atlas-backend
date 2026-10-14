/**
 * B0-BIL-13 — names of the plan limits the usage warnings talk about,
 * shared by the two templates.
 */
const LABELS: Record<'en' | 'ar', Record<string, string>> = {
  en: {
    students: 'students',
    courses: 'courses',
    academies: 'academies',
    generalStorage: 'storage',
  },
  ar: {
    students: 'المتعلّمين',
    courses: 'الدورات',
    academies: 'الأكاديميات',
    generalStorage: 'مساحة التخزين',
  },
};

export function limitLabel(locale: 'en' | 'ar', key: string): string {
  return LABELS[locale][key] ?? key;
}

/** "120 of 150", or "4.2 of 5 GB" for storage. */
export function limitAmount(
  locale: 'en' | 'ar',
  key: string,
  used: string,
  limit: string,
): string {
  const unit = key === 'generalStorage' ? (locale === 'ar' ? ' جيجابايت' : ' GB') : '';
  return locale === 'ar' ? `${used} من ${limit}${unit}` : `${used} of ${limit}${unit}`;
}
