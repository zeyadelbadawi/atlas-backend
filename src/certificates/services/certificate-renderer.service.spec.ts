import { CertificateRendererService } from './certificate-renderer.service';
import type { CertificateSnapshot } from '../dto/certificate.contract';
import { DEFAULT_WORDING } from '../dto/certificate.contract';

const snapshot = (over: Partial<CertificateSnapshot> = {}): CertificateSnapshot => ({
  learnerName: 'Alex Morgan',
  learnerEmailMasked: 'al***@student.dev',
  courseTitle: 'Spanish for Beginners',
  courseSlug: 'spanish-for-beginners',
  academyName: 'Language Learning Hub',
  academySlug: 'language-learning-hub',
  instructors: ['Jane Doe'],
  completedAt: '2026-09-22T10:00:00.000Z',
  overallScore: 92.5,
  scoreSummary: [{ title: 'Final quiz', score: 92.5 }],
  templateVersion: 1,
  templateId: null,
  logoUrl: null,
  signatureUrl: null,
  signatoryName: 'Dr. Example',
  signatoryTitle: 'Director',
  wording: DEFAULT_WORDING,
  locale: 'en',
  ...over,
});

describe('CertificateRendererService', () => {
  // Font parsing and the image fetch time-out take longer than jest's 5 s default under a parallel run.
  jest.setTimeout(30_000);
  const renderer = new CertificateRendererService();

  it('embeds the vendored fonts', () => {
    expect(renderer.fontsAvailable).toBe(true);
  });

  it('renders an English certificate as a real PDF with the QR and the footer', async () => {
    const { pdf, warnings } = await renderer.render({
      snapshot: snapshot(),
      serial: 'LLH-2026-000001',
      verificationCode: 'ABCDEFGHJK23',
      verificationCodeDisplay: 'ABCD-EFGH-JK23',
      verifyUrl: 'https://atlass.dpdns.org/verify/ABCD-EFGH-JK23',
      issuedAt: new Date('2026-09-22T10:05:00.000Z'),
      version: 1,
      locale: 'en',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(20_000); // embedded (subset) fonts + QR
    expect(warnings).toEqual([]);
    const text = pdf.toString('latin1');
    expect(text).toContain('/Type /XObject'); // the QR image
    expect(text).toContain('/FontFile2'); // embedded TrueType
  });

  it('renders an Arabic certificate with the Arabic face and never throws on shaping', async () => {
    const { pdf } = await renderer.render({
      snapshot: snapshot({
        learnerName: 'أليكس مورغان',
        courseTitle: 'أساسيات اللغة العربية',
        academyName: 'مركز تعلم اللغات',
        locale: 'ar',
      }),
      serial: 'MTL-2026-000002',
      verificationCode: 'ZYXWVTSRQPNM',
      verificationCodeDisplay: 'ZYXW-VTSR-QPNM',
      verifyUrl: 'https://atlass.dpdns.org/verify/ZYXW-VTSR-QPNM',
      issuedAt: new Date('2026-09-22T10:05:00.000Z'),
      version: 2,
      locale: 'ar',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('NotoSansArabic');
  });

  it('tolerates an unreachable logo: the certificate still renders and the warning is reported', async () => {
    const { pdf, warnings } = await renderer.render({
      snapshot: snapshot({ logoUrl: 'https://127.0.0.1:9/no-such-logo.png' }),
      serial: 'LLH-2026-000003',
      verificationCode: 'ABCDEFGHJK24',
      verificationCodeDisplay: 'ABCD-EFGH-JK24',
      verifyUrl: 'https://atlass.dpdns.org/verify/ABCD-EFGH-JK24',
      issuedAt: new Date(),
      version: 1,
      locale: 'en',
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(warnings.some((w) => w.startsWith('logo:'))).toBe(true);
  });
});
