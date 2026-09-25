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
import { deriveRenderPalette, type RenderPalette } from '../certificate-palette.util';

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

const ARABIC_LETTER = new RegExp(
  '[\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]',
);
// Digits (Western, Arabic-Indic, Extended Arabic-Indic) and Latin letters read
// LEFT-TO-RIGHT even inside Arabic. Arabic-Indic digits sit inside the Arabic
// block, so this MUST be tested before ARABIC_LETTER.
const LTR_CONTENT = /[0-9٠-٩۰-۹A-Za-z]/;

/**
 * pdfkit has no Unicode Bidi Algorithm: fontkit reverses an entire run that
 * contains Arabic, which is right for Arabic letters but flips embedded
 * numbers ("2026" → "٦٢٠٢", "96%" → "٦٩") and Latin names ("Dr. Jordan Hayes"
 * → reversed). Arabic-Indic digits sit inside the Arabic block, so they are
 * caught too. This pre-reverses each maximal left-to-right sub-run so that
 * fontkit's whole-run reversal lands it back the right way, leaving pure
 * Arabic (and any pure-Latin line) untouched. A small, dependency-free bidi
 * for the one shape certificates use: an RTL line with embedded LTR spans.
 */
export function reorderMixedRtl(value: string): string {
  const chars = [...value];
  if (!chars.some((c) => ARABIC_LETTER.test(c))) return value; // pure LTR line
  type Cls = 'R' | 'L' | 'N';
  const cls: Cls[] = chars.map((c) =>
    // LTR content FIRST — Arabic-Indic digits also match ARABIC_LETTER but must
    // read left-to-right. Everything else (spaces, punctuation) is neutral and
    // is resolved by its neighbours below.
    LTR_CONTENT.test(c) ? 'L' : ARABIC_LETTER.test(c) ? 'R' : 'N',
  );
  // Resolve neutrals (spaces): a neutral run joins an LTR span only when it is
  // flanked by LTR on both sides; otherwise it belongs to the RTL base.
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] !== 'N') continue;
    let l = i - 1;
    while (l >= 0 && cls[l] === 'N') l--;
    let r = i + 1;
    while (r < cls.length && cls[r] === 'N') r++;
    const left = l >= 0 ? cls[l] : 'R';
    const right = r < cls.length ? cls[r] : 'R';
    cls[i] = left === 'L' && right === 'L' ? 'L' : 'R';
  }
  // Reverse each maximal LTR span in place; fontkit re-reverses it to correct.
  let i = 0;
  while (i < chars.length) {
    if (cls[i] !== 'L') {
      i++;
      continue;
    }
    let j = i;
    while (j < chars.length && cls[j] === 'L') j++;
    const span = chars.slice(i, j).reverse();
    for (let k = 0; k < span.length; k++) chars[i + k] = span[k];
    i = j;
  }
  return chars.join('');
}

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

/**
 * One restrained palette — deep ink, a warm gold accent and a paper ground.
 * A professional certificate earns its weight from hierarchy and space, not
 * from many colours; the gold appears only on the frame, the seal and two
 * short rules, so it reads as a foil accent rather than decoration.
 */
// The palette is no longer a module constant: each render derives its full
// set from the certificate's own (immutable, per-snapshot) four colour roles
// via deriveRenderPalette, so the Client Owner's chosen colours drive the PDF
// while an old snapshot with no palette still yields the original design.

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
    const centerX = PAGE_WIDTH / 2;
    // The certificate's own colours (frozen in its snapshot). Old snapshots
    // with no palette derive the original Atlas design.
    const palette = deriveRenderPalette(input.snapshot.palette);

    // A warm off-white ground so the ink and gold read as print, not screen.
    doc.save().rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(palette.paper).restore();
    this.drawFrame(doc, palette);

    // ---- Masthead: academy identity (logo, or the Atlas mark as the
    // deterministic fallback) + academy name in a quiet, tracked line. ----
    let y = 62;
    const markHeight = 54;
    if (logo) {
      doc.image(logo, centerX - 70, y, {
        fit: [140, markHeight],
        align: 'center',
        valign: 'center',
      });
    } else {
      // No academy logo configured → Atlas is the identity here, drawn as a
      // small wordmark so the certificate is never unbranded.
      this.drawAtlasWordmark(doc, centerX, y + markHeight / 2, false, palette);
    }
    y += markHeight + 14;

    this.text(doc, input.snapshot.academyName.toUpperCase(), {
      y,
      size: 12,
      bold: true,
      color: palette.inkSoft,
      rtl,
      characterSpacing: rtl ? 0 : 2.4,
    });
    y += 34;

    // ---- Title, with a short gold rule beneath it. ----
    this.text(doc, wording.title.toUpperCase(), {
      y,
      size: 30,
      bold: true,
      color: palette.ink,
      rtl,
      characterSpacing: rtl ? 0 : 3,
    });
    y += 42;
    this.goldRule(doc, centerX, y, 90, palette);
    y += 22;

    // ---- Presentation lines and the learner name (the focal point). ----
    this.text(
      doc,
      rtl ? 'تُقدَّم هذه الشهادة بفخر إلى' : 'This certificate is proudly presented to',
      {
        y,
        size: 12,
        color: palette.inkSoft,
        rtl,
      },
    );
    y += 30;

    this.text(doc, input.snapshot.learnerName, {
      y,
      // Auto-fit so a very long name stays on one line (the focal point must
      // never wrap into the body) rather than overflowing.
      size: this.fitSize(
        doc,
        input.snapshot.learnerName,
        true,
        34,
        18,
        contentWidth - 40,
      ),
      bold: true,
      color: palette.ink,
      rtl,
    });
    y += 50;
    // A hairline flourish under the name, its width tied to the name length.
    this.nameFlourish(doc, centerX, y, palette);
    y += 16;

    // ---- Body wording + the course title. ----
    this.text(doc, wording.body, { y, size: 12, color: palette.inkSoft, rtl });
    y += 24;
    this.text(doc, input.snapshot.courseTitle, {
      y,
      size: this.fitSize(
        doc,
        input.snapshot.courseTitle,
        true,
        21,
        13,
        contentWidth - 40,
      ),
      bold: true,
      color: palette.accentDeep,
      rtl,
    });
    y += 34;

    // ---- Completion date and score on one quiet line. ----
    const completed = new Date(input.snapshot.completedAt);
    const dateText = new Intl.DateTimeFormat(rtl ? 'ar-EG' : 'en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(completed);
    const metaParts = [rtl ? `أُكملت في ${dateText}` : `Completed on ${dateText}`];
    if (input.snapshot.overallScore !== null) {
      metaParts.push(
        rtl
          ? `الدرجة ${this.number(input.snapshot.overallScore, rtl)}٪`
          : `Score ${this.number(input.snapshot.overallScore, rtl)}%`,
      );
    }
    this.text(doc, metaParts.join(rtl ? '  •  ' : '   •   '), {
      y,
      size: 11,
      color: palette.inkSoft,
      rtl,
    });
    y += 16;
    if (input.snapshot.instructors.length > 0) {
      const line = rtl
        ? `بإشراف: ${input.snapshot.instructors.join('، ')}`
        : `Instructor${input.snapshot.instructors.length > 1 ? 's' : ''}: ${input.snapshot.instructors.join(', ')}`;
      this.text(doc, line, { y, size: 10, color: palette.inkSoft, rtl });
    }

    // ---- Bottom band: signature (start side), the gold verification seal
    // (centre), and the QR + code (end side). ----
    const bandY = PAGE_HEIGHT - 150;
    const colWidth = 210;
    const signatureX = rtl ? PAGE_WIDTH - MARGIN - 24 - colWidth : MARGIN + 24;
    const qrColX = rtl ? MARGIN + 24 : PAGE_WIDTH - MARGIN - 24 - colWidth;

    // Signature column.
    if (signature) {
      doc.image(signature, signatureX + colWidth / 2 - 70, bandY - 8, { fit: [140, 40] });
    }
    doc
      .save()
      .lineWidth(0.8)
      .strokeColor(palette.rule)
      .moveTo(signatureX + 20, bandY + 40)
      .lineTo(signatureX + colWidth - 20, bandY + 40)
      .stroke()
      .restore();
    // When a signatory is configured, show the name (auto-fit to one line)
    // over its title. When NONE is, the academy is already the masthead, so
    // the block is just a short "Authorised by the academy" — never the long
    // academy name wrapping into the title.
    if (input.snapshot.signatoryName) {
      this.text(doc, input.snapshot.signatoryName, {
        y: bandY + 46,
        size: this.fitSize(doc, input.snapshot.signatoryName, true, 11, 8, colWidth - 12),
        bold: true,
        color: palette.ink,
        rtl,
        x: signatureX,
        width: colWidth,
        align: 'center',
      });
      this.text(
        doc,
        input.snapshot.signatoryTitle ??
          (rtl ? 'عن الأكاديمية' : 'On behalf of the academy'),
        {
          y: bandY + 60,
          size: 9,
          color: palette.inkSoft,
          rtl,
          x: signatureX,
          width: colWidth,
          align: 'center',
        },
      );
    } else {
      this.text(doc, rtl ? 'مُعتمَدة من الأكاديمية' : 'Authorised by the academy', {
        y: bandY + 52,
        size: 9,
        color: palette.inkSoft,
        rtl,
        x: signatureX,
        width: colWidth,
        align: 'center',
      });
    }

    // Centre seal.
    this.drawSeal(doc, centerX, bandY + 24, rtl, palette);

    // QR + verification code column.
    const qrSize = 64;
    const qrX = qrColX + colWidth / 2 - qrSize / 2;
    doc.image(qr, qrX, bandY - 8, { width: qrSize, height: qrSize });
    this.text(doc, rtl ? 'تحقّق من صحّتها' : 'Scan to verify', {
      y: bandY + 58,
      size: 8,
      color: palette.inkSoft,
      rtl,
      x: qrColX,
      width: colWidth,
      align: 'center',
    });
    this.text(doc, input.verificationCodeDisplay, {
      y: bandY + 68,
      size: 10,
      bold: true,
      color: palette.ink,
      rtl: false,
      x: qrColX,
      width: colWidth,
      align: 'center',
      characterSpacing: 1.5,
    });

    // ---- Footer rule + serial / issue metadata + Atlas attribution. ----
    doc
      .save()
      .lineWidth(0.8)
      .strokeColor(palette.rule)
      .moveTo(MARGIN + 6, PAGE_HEIGHT - 52)
      .lineTo(PAGE_WIDTH - MARGIN - 6, PAGE_HEIGHT - 52)
      .stroke()
      .restore();
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
      y: PAGE_HEIGHT - 44,
      size: 8,
      color: palette.inkSoft,
      rtl,
      x: MARGIN + 6,
      width: contentWidth - 12,
      align: rtl ? 'right' : 'left',
    });
    this.text(
      doc,
      rtl ? 'صادرة ومُوثَّقة عبر Atlas' : 'Issued & verified through Atlas',
      {
        y: PAGE_HEIGHT - 44,
        size: 8,
        bold: true,
        color: palette.accentDeep,
        rtl,
        x: MARGIN + 6,
        width: contentWidth - 12,
        align: rtl ? 'left' : 'right',
      },
    );
    if (input.snapshot.anonymizedAt) {
      this.text(
        doc,
        rtl
          ? 'أُخفيت هوية صاحب الشهادة بناءً على طلبه.'
          : "The holder's identity was anonymised at their request.",
        {
          y: PAGE_HEIGHT - 33,
          size: 7,
          color: palette.inkSoft,
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
      readonly characterSpacing?: number;
    },
  ): void {
    const safe = stripControlCharacters(value).trim();
    if (!safe) return;
    const x = opts.x ?? MARGIN;
    const width = opts.width ?? PAGE_WIDTH - MARGIN * 2;
    const isArabic = ARABIC_RANGE.test(safe);
    // Bidi: fix numbers and embedded Latin inside an Arabic line before
    // fontkit's whole-run RTL reversal (see reorderMixedRtl). Pure Arabic and
    // pure Latin lines are returned unchanged.
    const shaped = isArabic ? reorderMixedRtl(safe) : safe;
    doc
      .font(this.fontFor(safe, opts.bold ?? false))
      .fontSize(opts.size)
      .fillColor(opts.color ?? '#000000')
      .text(shaped, x, opts.y, {
        width,
        align: opts.align ?? 'center',
        lineBreak: true,
        // Letter-spacing lifts short display lines; never applied to Arabic,
        // where inserting space between glyphs breaks the joined script.
        characterSpacing: isArabic ? 0 : (opts.characterSpacing ?? 0),
        // Arabic shaping (init/medi/fina/isol forms and ligatures) comes
        // from fontkit's OpenType layout; `rtla` enables right-to-left
        // alternates where the face defines them.
        features: isArabic ? ['rtla', 'calt', 'liga'] : ['calt', 'liga'],
      });
  }

  /** The double frame: a thin ink rule, a gold hairline inside it, and a short gold accent at each corner. */
  private drawFrame(doc: PDFKit.PDFDocument, palette: RenderPalette): void {
    doc.save();
    doc
      .lineWidth(1.4)
      .strokeColor(palette.ink)
      .rect(22, 22, PAGE_WIDTH - 44, PAGE_HEIGHT - 44)
      .stroke();
    doc
      .lineWidth(0.8)
      .strokeColor(palette.gold)
      .rect(29, 29, PAGE_WIDTH - 58, PAGE_HEIGHT - 58)
      .stroke();
    // Corner accents — short double rules that read as inlaid foil.
    const len = 26;
    const insets: [number, number, number, number][] = [
      [29, 29, 1, 1],
      [PAGE_WIDTH - 29, 29, -1, 1],
      [29, PAGE_HEIGHT - 29, 1, -1],
      [PAGE_WIDTH - 29, PAGE_HEIGHT - 29, -1, -1],
    ];
    doc.lineWidth(1.6).strokeColor(palette.gold);
    for (const [cx, cy, sx, sy] of insets) {
      doc
        .moveTo(cx, cy + sy * len)
        .lineTo(cx, cy)
        .lineTo(cx + sx * len, cy)
        .stroke();
    }
    doc.restore();
  }

  /** A short centred gold rule with a small lozenge at its midpoint. */
  private goldRule(
    doc: PDFKit.PDFDocument,
    centerX: number,
    y: number,
    half: number,
    palette: RenderPalette,
  ): void {
    doc.save();
    doc
      .lineWidth(1)
      .strokeColor(palette.gold)
      .moveTo(centerX - half, y)
      .lineTo(centerX - 8, y)
      .moveTo(centerX + 8, y)
      .lineTo(centerX + half, y)
      .stroke();
    doc
      .fillColor(palette.gold)
      .moveTo(centerX, y - 4)
      .lineTo(centerX + 4, y)
      .lineTo(centerX, y + 4)
      .lineTo(centerX - 4, y)
      .fill();
    doc.restore();
  }

  /** A tapered hairline under the learner's name. */
  private nameFlourish(
    doc: PDFKit.PDFDocument,
    centerX: number,
    y: number,
    palette: RenderPalette,
  ): void {
    doc.save();
    doc
      .lineWidth(0.8)
      .strokeColor(palette.goldSoft)
      .moveTo(centerX - 120, y)
      .lineTo(centerX + 120, y)
      .stroke();
    doc.restore();
  }

  /**
   * The Atlas wordmark, drawn (there is no logo image to embed): a small
   * gold ring holding a stylised "A", then "ATLAS" in tracked ink caps. Used
   * as the deterministic masthead when an academy has configured no logo, so
   * a certificate is never unbranded.
   */
  private drawAtlasWordmark(
    doc: PDFKit.PDFDocument,
    centerX: number,
    midY: number,
    small: boolean,
    palette: RenderPalette,
  ): void {
    const r = small ? 12 : 15;
    const markX = centerX - (small ? 34 : 44);
    doc.save();
    doc.lineWidth(1.6).strokeColor(palette.gold).circle(markX, midY, r).stroke();
    doc
      .font(this.fontFor('A', true))
      .fontSize(small ? 13 : 16)
      .fillColor(palette.ink)
      .text('A', markX - r, midY - (small ? 7 : 9), {
        width: r * 2,
        align: 'center',
        lineBreak: false,
      });
    doc
      .font(this.fontFor('ATLAS', true))
      .fontSize(small ? 15 : 19)
      .fillColor(palette.ink)
      .text('ATLAS', markX + r + 8, midY - (small ? 8 : 10), {
        lineBreak: false,
        characterSpacing: 3,
      });
    doc.restore();
  }

  /**
   * A gold verification seal — concentric rings, a ring of ticks, and a
   * centred check — the visual cue that this is an issued, verifiable
   * credential rather than a printout. Drawn, so it needs no asset and
   * scales crisply.
   */
  private drawSeal(
    doc: PDFKit.PDFDocument,
    cx: number,
    cy: number,
    rtl: boolean,
    palette: RenderPalette,
  ): void {
    doc.save();
    doc.lineWidth(1.4).strokeColor(palette.gold).circle(cx, cy, 34).stroke();
    doc.lineWidth(0.8).strokeColor(palette.goldSoft).circle(cx, cy, 28).stroke();
    // A ring of short ticks between the two circles.
    doc.lineWidth(1).strokeColor(palette.gold);
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      doc
        .moveTo(cx + Math.cos(a) * 30, cy + Math.sin(a) * 30)
        .lineTo(cx + Math.cos(a) * 33, cy + Math.sin(a) * 33)
        .stroke();
    }
    // Centred check mark.
    doc
      .lineWidth(2.2)
      .strokeColor(palette.accentDeep)
      .moveTo(cx - 9, cy)
      .lineTo(cx - 2, cy + 8)
      .lineTo(cx + 11, cy - 8)
      .stroke();
    this.text(doc, rtl ? 'مُوثَّقة' : 'VERIFIED', {
      y: cy + 40,
      size: 7,
      bold: true,
      color: palette.gold,
      rtl,
      x: cx - 40,
      width: 80,
      align: 'center',
      characterSpacing: rtl ? 0 : 2,
    });
    doc.restore();
  }

  /**
   * The largest font size in `[min, max]` at which `value` fits on ONE line
   * within `maxWidth` — so a long learner name or course title shrinks to
   * stay on its line instead of wrapping into whatever follows it.
   */
  private fitSize(
    doc: PDFKit.PDFDocument,
    value: string,
    bold: boolean,
    max: number,
    min: number,
    maxWidth: number,
  ): number {
    const safe = stripControlCharacters(value).trim();
    if (!safe) return max;
    doc.font(this.fontFor(safe, bold));
    for (let size = max; size > min; size -= 1) {
      if (doc.fontSize(size).widthOfString(safe) <= maxWidth) return size;
    }
    return min;
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
