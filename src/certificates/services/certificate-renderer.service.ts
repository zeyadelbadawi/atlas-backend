/**
 * P64 Phase 3 (D6) — server-side PDF rendering with embedded fonts.
 *
 * No headless browser. `pdfkit` draws the platform-standard layout; the
 * Noto Sans / Noto Sans Arabic faces are embedded (subset) from
 * `assets/fonts`, so Arabic shaping and Latin text both render on a
 * server with no system fonts. The academy's identity (logo, signature,
 * signatory, wording) comes from the immutable snapshot, never from the
 * live template — a certificate re-renders exactly as it was issued
 * unless regeneration explicitly produces a new version.
 *
 * Images are fetched with a size cap and a timeout and normalised to PNG
 * through `sharp`; a failing logo never fails the certificate — the layout
 * simply omits it and the render log says so.
 */
import { Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import sharp from 'sharp';
import type { CertificateSnapshot } from '../dto/certificate.contract';

export interface RenderInput {
  readonly snapshot: CertificateSnapshot;
  readonly serial: string;
  readonly verificationCode: string;
  readonly verificationCodeDisplay: string;
  readonly verifyUrl: string;
  readonly issuedAt: Date;
  readonly version: number;
  readonly locale: 'en' | 'ar';
}

export interface RenderOutput {
  readonly pdf: Buffer;
  readonly warnings: readonly string[];
}

const FONT_DIR_CANDIDATES = [
  resolve(process.cwd(), 'assets/fonts'),
  resolve(__dirname, '../../../assets/fonts'),
  resolve(__dirname, '../../../../assets/fonts'),
];

const ARABIC_RANGE = new RegExp(
  '[\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]',
);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 5_000;

/** Drops C0 control characters (keeps tab/newline/CR) so a pasted name cannot inject PDF operators. */
function stripControlCharacters(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
    out += ch;
  }
  return out;
}

// A4 landscape in points.
const PAGE_WIDTH = 841.89;
const PAGE_HEIGHT = 595.28;
const MARGIN = 48;

@Injectable()
export class CertificateRendererService {
  private readonly logger = new Logger(CertificateRendererService.name);
  private readonly fontDir: string | null;

  constructor() {
    this.fontDir =
      FONT_DIR_CANDIDATES.find((dir) =>
        existsSync(resolve(dir, 'NotoSans-Regular.ttf')),
      ) ?? null;
    if (!this.fontDir) {
      this.logger.error(
        { candidates: FONT_DIR_CANDIDATES },
        'Certificate fonts not found; Arabic certificates cannot be rendered until assets/fonts is present.',
      );
    }
  }

  get fontsAvailable(): boolean {
    return this.fontDir !== null;
  }

  async render(input: RenderInput): Promise<RenderOutput> {
    const warnings: string[] = [];
    const [logo, signature, qr] = await Promise.all([
      this.fetchImage(input.snapshot.logoUrl, 'logo', warnings),
      this.fetchImage(input.snapshot.signatureUrl, 'signature', warnings),
      QRCode.toBuffer(input.verifyUrl, {
        type: 'png',
        margin: 1,
        width: 240,
        errorCorrectionLevel: 'M',
      }),
    ]);

    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: MARGIN,
      info: {
        Title: `${input.snapshot.wording[input.locale].title} — ${input.snapshot.learnerName}`,
        Author: input.snapshot.academyName,
        Subject: input.snapshot.courseTitle,
        Keywords: `certificate ${input.serial}`,
      },
      pdfVersion: '1.7',
    });
    this.registerFonts(doc);

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolveDone, reject) => {
      doc.on('end', () => resolveDone(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const rtl = input.locale === 'ar';
    const wording = input.snapshot.wording[input.locale];
    const contentWidth = PAGE_WIDTH - MARGIN * 2;

    // Border and accent.
    doc.save();
    doc
      .lineWidth(3)
      .strokeColor('#1f4e5f')
      .rect(24, 24, PAGE_WIDTH - 48, PAGE_HEIGHT - 48)
      .stroke();
    doc
      .lineWidth(1)
      .strokeColor('#8fbfc7')
      .rect(32, 32, PAGE_WIDTH - 64, PAGE_HEIGHT - 64)
      .stroke();
    doc.restore();

    let y = 56;
    if (logo) {
      const logoHeight = 64;
      doc.image(logo, PAGE_WIDTH / 2 - 60, y, {
        fit: [120, logoHeight],
        align: 'center',
        valign: 'center',
      });
      y += logoHeight + 8;
    }

    // Academy name.
    this.text(doc, input.snapshot.academyName, {
      y,
      size: 16,
      bold: true,
      color: '#1f4e5f',
      rtl,
    });
    y += 30;

    // Title.
    this.text(doc, wording.title, { y, size: 34, bold: true, color: '#0f2f3a', rtl });
    y += 56;

    // "This certifies that" line.
    this.text(doc, rtl ? 'تشهد هذه الوثيقة بأن' : 'This is to certify that', {
      y,
      size: 13,
      color: '#4a5a60',
      rtl,
    });
    y += 26;

    // Learner name.
    this.text(doc, input.snapshot.learnerName, {
      y,
      size: 30,
      bold: true,
      color: '#0f2f3a',
      rtl,
    });
    y += 46;

    // Body wording.
    this.text(doc, wording.body, { y, size: 13, color: '#4a5a60', rtl });
    y += 24;

    // Course title.
    this.text(doc, input.snapshot.courseTitle, {
      y,
      size: 22,
      bold: true,
      color: '#1f4e5f',
      rtl,
    });
    y += 40;

    // Completion date and score summary.
    const completed = new Date(input.snapshot.completedAt);
    const dateText = new Intl.DateTimeFormat(rtl ? 'ar-EG' : 'en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(completed);
    const dateLine = rtl ? `تاريخ الإتمام: ${dateText}` : `Completed on ${dateText}`;
    this.text(doc, dateLine, { y, size: 12, color: '#4a5a60', rtl });
    y += 20;
    if (input.snapshot.overallScore !== null) {
      const scoreLine = rtl
        ? `الدرجة الإجمالية عند الإصدار: ${this.number(input.snapshot.overallScore, rtl)}%`
        : `Overall score at issuance: ${this.number(input.snapshot.overallScore, rtl)}%`;
      this.text(doc, scoreLine, { y, size: 11, color: '#4a5a60', rtl });
      y += 18;
    }
    if (input.snapshot.instructors.length > 0) {
      const line = rtl
        ? `المدرّسون: ${input.snapshot.instructors.join('، ')}`
        : `Instructors: ${input.snapshot.instructors.join(', ')}`;
      this.text(doc, line, { y, size: 11, color: '#4a5a60', rtl });
    }

    // Signature block (start side) and QR block (end side).
    const bottom = PAGE_HEIGHT - 150;
    const signatureX = rtl ? PAGE_WIDTH - MARGIN - 220 : MARGIN + 20;
    if (signature) {
      doc.image(signature, signatureX + 30, bottom, { fit: [160, 50] });
    }
    doc
      .save()
      .lineWidth(1)
      .strokeColor('#8fbfc7')
      .moveTo(signatureX, bottom + 58)
      .lineTo(signatureX + 220, bottom + 58)
      .stroke()
      .restore();
    if (input.snapshot.signatoryName) {
      this.text(doc, input.snapshot.signatoryName, {
        y: bottom + 64,
        size: 11,
        bold: true,
        color: '#0f2f3a',
        rtl,
        x: signatureX,
        width: 220,
        align: 'center',
      });
    }
    if (input.snapshot.signatoryTitle) {
      this.text(doc, input.snapshot.signatoryTitle, {
        y: bottom + 80,
        size: 9,
        color: '#4a5a60',
        rtl,
        x: signatureX,
        width: 220,
        align: 'center',
      });
    }

    const qrSize = 84;
    const qrX = rtl ? MARGIN + 20 : PAGE_WIDTH - MARGIN - 20 - qrSize;
    doc.image(qr, qrX, bottom - 10, { width: qrSize, height: qrSize });
    this.text(doc, rtl ? 'تحقق من الشهادة' : 'Verify this certificate', {
      y: bottom + 78,
      size: 8,
      color: '#4a5a60',
      rtl,
      x: qrX - 40,
      width: qrSize + 80,
      align: 'center',
    });
    this.text(doc, input.verificationCodeDisplay, {
      y: bottom + 90,
      size: 9,
      bold: true,
      color: '#0f2f3a',
      rtl: false,
      x: qrX - 40,
      width: qrSize + 80,
      align: 'center',
    });

    // Footer: serial, issue date, "Issued via Atlas".
    const issued = new Intl.DateTimeFormat(rtl ? 'ar-EG' : 'en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(input.issuedAt);
    const footerLeft = rtl
      ? `الرقم التسلسلي ${input.serial} · صدرت في ${issued} · الإصدار ${this.number(input.version, rtl)}`
      : `Serial ${input.serial} · Issued ${issued} · Version ${input.version}`;
    this.text(doc, footerLeft, {
      y: PAGE_HEIGHT - 52,
      size: 8,
      color: '#6b7a80',
      rtl,
      x: MARGIN,
      width: contentWidth,
      align: rtl ? 'right' : 'left',
    });
    this.text(doc, rtl ? 'صادرة عبر Atlas' : 'Issued via Atlas', {
      y: PAGE_HEIGHT - 52,
      size: 8,
      bold: true,
      color: '#1f4e5f',
      rtl,
      x: MARGIN,
      width: contentWidth,
      align: rtl ? 'left' : 'right',
    });
    if (input.snapshot.anonymizedAt) {
      this.text(
        doc,
        rtl
          ? 'تم إخفاء هوية صاحب الشهادة بناءً على طلبه.'
          : "The holder's identity was anonymised at their request.",
        {
          y: PAGE_HEIGHT - 40,
          size: 7,
          color: '#6b7a80',
          rtl,
          x: MARGIN,
          width: contentWidth,
          align: 'center',
        },
      );
    }

    doc.end();
    const pdf = await done;
    return { pdf, warnings };
  }

  // ---------------------------------------------------------------------

  private registerFonts(doc: PDFKit.PDFDocument): void {
    if (!this.fontDir) return;
    const path = (name: string) => resolve(this.fontDir!, name);
    doc.registerFont('Latin', path('NotoSans-Regular.ttf'));
    doc.registerFont('LatinBold', path('NotoSans-Bold.ttf'));
    doc.registerFont('Arabic', path('NotoSansArabic-Regular.ttf'));
    doc.registerFont('ArabicBold', path('NotoSansArabic-Bold.ttf'));
  }

  private fontFor(text: string, bold: boolean): string {
    if (!this.fontDir) return bold ? 'Helvetica-Bold' : 'Helvetica';
    const arabic = ARABIC_RANGE.test(text);
    if (arabic) return bold ? 'ArabicBold' : 'Arabic';
    return bold ? 'LatinBold' : 'Latin';
  }

  private text(
    doc: PDFKit.PDFDocument,
    value: string,
    opts: {
      readonly y: number;
      readonly size: number;
      readonly bold?: boolean;
      readonly color?: string;
      readonly rtl: boolean;
      readonly x?: number;
      readonly width?: number;
      readonly align?: 'left' | 'center' | 'right';
    },
  ): void {
    const safe = stripControlCharacters(value).trim();
    if (!safe) return;
    const x = opts.x ?? MARGIN;
    const width = opts.width ?? PAGE_WIDTH - MARGIN * 2;
    doc
      .font(this.fontFor(safe, opts.bold ?? false))
      .fontSize(opts.size)
      .fillColor(opts.color ?? '#000000')
      .text(safe, x, opts.y, {
        width,
        align: opts.align ?? 'center',
        lineBreak: true,
        // Arabic shaping (init/medi/fina/isol forms and ligatures) comes
        // from fontkit's OpenType layout; `rtla` enables right-to-left
        // alternates where the face defines them.
        features: ARABIC_RANGE.test(safe) ? ['rtla', 'calt', 'liga'] : ['calt', 'liga'],
      });
  }

  private number(value: number, rtl: boolean): string {
    return new Intl.NumberFormat(rtl ? 'ar-EG' : 'en-US', {
      maximumFractionDigits: 2,
    }).format(value);
  }

  private async fetchImage(
    url: string | null,
    label: string,
    warnings: string[],
  ): Promise<Buffer | null> {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        warnings.push(`${label}: unsupported URL scheme`);
        return null;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
      try {
        const response = await fetch(parsed, {
          signal: controller.signal,
          redirect: 'follow',
        });
        if (!response.ok) {
          warnings.push(`${label}: HTTP ${response.status}`);
          return null;
        }
        const length = Number(response.headers.get('content-length') ?? 0);
        if (length > MAX_IMAGE_BYTES) {
          warnings.push(`${label}: too large`);
          return null;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) {
          warnings.push(`${label}: too large`);
          return null;
        }
        // Normalise through sharp: rejects non-images, converts webp/gif/svg-less to PNG.
        return await sharp(bytes, { limitInputPixels: 20_000_000 }).png().toBuffer();
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      warnings.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
