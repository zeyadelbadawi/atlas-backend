/**
 * P64 Phase 3 (D6) — certificate projections.
 *
 * `CertificateSnapshot` is the immutable issuance record stored as JSON:
 * what the certificate SAID at the moment it was issued. A later quiz
 * retake, a course rename or a template edit never rewrites it (D7);
 * regeneration creates a new version from a new snapshot explicitly.
 */
import type { Certificate, CertificateTemplate } from '@prisma/client';
import { formatVerificationCode } from '../certificate-serial.util';
import type { CertificateWithNames } from '../certificates.repository';
import {
  type CertificatePalette,
  DEFAULT_PALETTE,
  paletteFromTemplate,
} from '../certificate-palette.util';

export interface CertificateSnapshot {
  readonly learnerName: string;
  readonly learnerEmailMasked: string;
  readonly courseTitle: string;
  readonly courseSlug: string;
  readonly academyName: string;
  readonly academySlug: string;
  readonly instructors: readonly string[];
  readonly completedAt: string;
  readonly overallScore: number | null;
  readonly scoreSummary: readonly {
    readonly title: string;
    readonly score: number | null;
  }[];
  readonly templateVersion: number;
  readonly templateId: string | null;
  readonly logoUrl: string | null;
  readonly signatureUrl: string | null;
  readonly signatoryName: string | null;
  readonly signatoryTitle: string | null;
  readonly wording: CertificateWordingByLocale;
  /**
   * The four palette roles frozen at issuance, so a later template recolour
   * never changes an already-issued certificate. Optional: older snapshots
   * omit it and render with DEFAULT_PALETTE (the original Atlas design).
   */
  readonly palette?: CertificatePalette;
  readonly locale: string;
  /** Present after account deletion: the learner's name was replaced. */
  readonly anonymizedAt?: string;
}

export interface CertificateWording {
  readonly title: string;
  readonly body: string;
}

export interface CertificateWordingByLocale {
  readonly en: CertificateWording;
  readonly ar: CertificateWording;
}

export const DEFAULT_WORDING: CertificateWordingByLocale = {
  en: {
    title: 'Certificate of Completion',
    body: 'has successfully completed the course',
  },
  ar: {
    title: 'شهادة إتمام',
    body: 'قد أتم بنجاح دورة',
  },
};

export interface CertificateTemplateResponse {
  readonly id: string;
  readonly academyId: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly signatureUrl: string | null;
  readonly signatoryName: string | null;
  readonly signatoryTitle: string | null;
  readonly wording: CertificateWordingByLocale;
  readonly palette: CertificatePalette;
  readonly version: number;
  readonly isDefault: boolean;
  readonly updatedAt: string;
}

export function parseWording(raw: unknown): CertificateWordingByLocale {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    Partial<CertificateWording> | undefined
  >;
  const pick = (locale: 'en' | 'ar'): CertificateWording => ({
    title:
      typeof value[locale]?.title === 'string' && value[locale]!.title!.trim()
        ? value[locale]!.title!.trim()
        : DEFAULT_WORDING[locale].title,
    body:
      typeof value[locale]?.body === 'string' && value[locale]!.body!.trim()
        ? value[locale]!.body!.trim()
        : DEFAULT_WORDING[locale].body,
  });
  return { en: pick('en'), ar: pick('ar') };
}

export function toTemplateResponse(
  template: CertificateTemplate,
): CertificateTemplateResponse {
  return {
    id: template.id,
    academyId: template.academyId,
    name: template.name,
    logoUrl: template.logoUrl,
    signatureUrl: template.signatureUrl,
    signatoryName: template.signatoryName,
    signatoryTitle: template.signatoryTitle,
    wording: parseWording(template.wording),
    palette: paletteFromTemplate(template),
    version: template.version,
    isDefault: template.isDefault,
    updatedAt: template.updatedAt.toISOString(),
  };
}

/** Re-exported so the service can build a snapshot palette without a second import. */
export { DEFAULT_PALETTE };
export type { CertificatePalette };

/** The learner's certificate (and the staff list row). Never the storage key. */
export interface CertificateResponse {
  readonly id: string;
  readonly academyId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly courseSlug: string;
  readonly enrollmentId: string;
  readonly studentId: string;
  readonly studentName: string;
  readonly studentEmail?: string;
  readonly serial: string;
  readonly verificationCode: string;
  readonly verificationCodeDisplay: string;
  readonly status: Certificate['status'];
  readonly version: number;
  readonly locale: string;
  readonly issuedAt: string;
  readonly issuedManually: boolean;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
  readonly renderStatus: Certificate['renderStatus'];
  readonly renderedAt: string | null;
  readonly completedAt: string | null;
  readonly overallScore: number | null;
  readonly learnerNameOnCertificate: string;
}

export function toCertificateResponse(
  certificate: CertificateWithNames,
  options: { readonly includeEmail?: boolean } = {},
): CertificateResponse {
  const snapshot = certificate.snapshot as unknown as Partial<CertificateSnapshot>;
  return {
    id: certificate.id,
    academyId: certificate.academyId,
    courseId: certificate.courseId,
    courseTitle: snapshot.courseTitle ?? certificate.course.title,
    courseSlug: certificate.course.slug,
    enrollmentId: certificate.enrollmentId,
    studentId: certificate.studentId,
    studentName: certificate.student.name,
    ...(options.includeEmail ? { studentEmail: certificate.student.email } : {}),
    serial: certificate.serial,
    verificationCode: certificate.verificationCode,
    verificationCodeDisplay: formatVerificationCode(certificate.verificationCode),
    status: certificate.status,
    version: certificate.version,
    locale: certificate.locale,
    issuedAt: certificate.issuedAt.toISOString(),
    issuedManually: certificate.issuedById !== null,
    revokedAt: certificate.revokedAt?.toISOString() ?? null,
    revokeReason: certificate.revokeReason,
    renderStatus: certificate.renderStatus,
    renderedAt: certificate.renderedAt?.toISOString() ?? null,
    completedAt: snapshot.completedAt ?? null,
    overallScore: snapshot.overallScore ?? null,
    learnerNameOnCertificate: snapshot.learnerName ?? certificate.student.name,
  };
}

export interface CertificateDownloadResponse {
  readonly certificateId: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly fileName: string;
}

/** Public verification. `valid: false` carries nothing else — uniform for unknown codes. */
export interface CertificateVerificationResponse {
  readonly valid: boolean;
  readonly status?: 'issued' | 'revoked';
  readonly serial?: string;
  readonly issuedTo?: string;
  readonly courseTitle?: string;
  readonly academyName?: string;
  readonly academySlug?: string;
  readonly issuedAt?: string;
  readonly completedAt?: string | null;
  readonly revokedAt?: string | null;
  readonly version?: number;
}
