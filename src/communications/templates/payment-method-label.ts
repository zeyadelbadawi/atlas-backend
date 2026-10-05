/** The manual method names the Academy Manual Payments emails use. Unknown types fall back to a generic name. */
const LABELS: Record<'en' | 'ar', Record<string, string>> = {
  en: {
    manual_bank_transfer: 'bank transfer',
    manual_instapay: 'InstaPay',
    manual_wallet_transfer: 'mobile wallet',
  },
  ar: {
    manual_bank_transfer: 'تحويل بنكي',
    manual_instapay: 'إنستاباي',
    manual_wallet_transfer: 'محفظة إلكترونية',
  },
};

export function paymentMethodLabel(locale: 'en' | 'ar', methodType: string): string {
  return (
    LABELS[locale][methodType] ?? (locale === 'ar' ? 'تحويل يدوي' : 'manual transfer')
  );
}
