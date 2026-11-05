/**
 * The legal entity that owns and operates the platform (B0-OC-17).
 *
 * Mirrors `COMPANY` in the frontend (src/config/company.config.ts): the
 * marketing site, the Terms and the Privacy Policy name the same company.
 * Platform emails (receipts included) print it in their signature; academy
 * emails keep the academy's own identity and never show it.
 *
 * Status (5 Nov 2026): the name is reserved (GAFI non-confusion certificate
 * 10258284) and incorporation is in progress. The commercial register and
 * tax registration numbers are zero placeholders (owner decision) until the
 * documents are issued.
 */
export interface CompanyIdentity {
  readonly legalName: { readonly en: string; readonly ar: string };
  readonly commercialRegisterNumber: string;
  readonly taxRegistrationNumber: string;
}

export const COMPANY: CompanyIdentity = {
  legalName: { en: 'CoreMind', ar: 'كور مايند للتكنولوجيا' },
  commercialRegisterNumber: '000000',
  taxRegistrationNumber: '000-000-000',
};

/** One line naming the operator and its registration numbers. */
export function companyLegalLine(locale: 'en' | 'ar', platformName: string): string {
  const { legalName, commercialRegisterNumber: cr, taxRegistrationNumber: tax } = COMPANY;
  return locale === 'ar'
    ? `${platformName} منصة تديرها شركة ${legalName.ar} · سجل تجاري رقم ${cr} · رقم التسجيل الضريبي ${tax}`
    : `${platformName} is operated by ${legalName.en} · Commercial register no. ${cr} · Tax registration no. ${tax}`;
}
