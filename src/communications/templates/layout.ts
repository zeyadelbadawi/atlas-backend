/**
 * Email layout — P64 Communications C2.
 *
 * One HTML base and one plain-text base shared by every template. The
 * HTML is deliberately plain: a single-column table, inline styles only
 * (no `<style>` block survives every mail client), logical alignment
 * (`text-align:start`) so the same markup reads correctly under
 * `dir="rtl"`, and a footer that says why the person received the email
 * and where to change that. No tracking pixel, no remote images beyond
 * the academy logo, no marketing tone.
 *
 * Every dynamic string is HTML-escaped here, once — templates never
 * concatenate raw values into markup.
 */
import type { CommunicationLocale } from '../catalog/communication-catalog';

export interface BrandingContext {
  readonly academyName?: string;
  /**
   * Absolute https URL of the email-safe PNG logo
   * (`GET /api/v1/public/websites/:academyId/logo?v=…` on the platform host),
   * or absent — then the academy name is rendered as text instead.
   */
  readonly academyLogoUrl?: string;
  /** Display size for `academyLogoUrl` (Outlook ignores CSS sizing; attributes are required). */
  readonly academyLogoWidth?: number;
  readonly academyLogoHeight?: number;
  readonly academyHost?: string;
  readonly platformName: string;
  readonly platformUrl: string;
}

export interface TemplateRenderContext {
  readonly locale: CommunicationLocale;
  readonly branding: BrandingContext;
  /** Absolute call-to-action URL (already branded), or `null` when the key has none. */
  readonly actionUrl: string | null;
  /** Absolute URL of the recipient's communication settings. */
  readonly settingsUrl: string;
}

export type TemplateValues = Record<string, unknown>;

export interface TemplateLocale {
  readonly subject: (values: TemplateValues, context: TemplateRenderContext) => string;
  readonly preheader?: (values: TemplateValues, context: TemplateRenderContext) => string;
  readonly text: (values: TemplateValues, context: TemplateRenderContext) => string;
  readonly html: (values: TemplateValues, context: TemplateRenderContext) => string;
}

export interface CommunicationTemplate {
  /** Bumped whenever copy changes; recorded on every delivery row. */
  readonly version: string;
  readonly en: TemplateLocale;
  readonly ar: TemplateLocale;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Reads a string-ish value; never renders `undefined`. */
export function str(values: TemplateValues, key: string, fallback = ''): string {
  const value = values[key];
  // A blank string is a MISSING value, not content: rendering it would put
  // a hole in the sentence ("You've been added to  on Atlas") instead of
  // the fallback the template chose for exactly that case.
  if (typeof value === 'string') return value.trim() === '' ? fallback : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

const FOOTER = {
  en: {
    why: (brand: string) =>
      `You received this email because you have an account with ${brand}.`,
    settings: 'Manage email settings',
    sentBy: (platform: string) => `Sent by ${platform}`,
  },
  ar: {
    why: (brand: string) => `وصلتك هذه الرسالة لأن لديك حسابًا لدى ${brand}.`,
    settings: 'إدارة إعدادات البريد',
    sentBy: (platform: string) => `أُرسلت بواسطة ${platform}`,
  },
} as const;

export interface LayoutInput {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly preheader?: string;
  readonly cta?: { readonly label: string; readonly url: string };
  /** Extra pre-rendered HTML block placed after the paragraphs (digest lists). Already escaped by the caller. */
  readonly extraHtml?: string;
  /** Plain-text counterpart of `extraHtml`. */
  readonly extraText?: string;
}

function brandName(context: TemplateRenderContext): string {
  return context.branding.academyName ?? context.branding.platformName;
}

/**
 * Only an absolute http(s) URL is ever put into `<img src>` — anything else
 * (a `data:` URI, a relative path, a script scheme) falls back to text.
 * Production builds it on the https platform host; plain http is admitted
 * only so a local `PLATFORM_WEB_URL=http://localhost:…` still renders.
 */
function isEmailSafeImageUrl(url: string | undefined): url is string {
  return typeof url === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(url);
}

function positiveInt(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

/**
 * The header brand mark: the academy logo with explicit `width`/`height`
 * attributes (Outlook's Word engine ignores CSS sizing), `alt` = the brand
 * name, and the email-client-safe inline reset — or, when there is no usable
 * logo, the brand name as text. A `data:` URI or a relative path never
 * reaches `src`.
 */
function renderLogo(branding: BrandingContext, brand: string): string {
  if (!isEmailSafeImageUrl(branding.academyLogoUrl)) {
    return `<span style="font-size:18px;font-weight:600;color:#111827;">${escapeHtml(brand)}</span>`;
  }
  const height = positiveInt(branding.academyLogoHeight) ?? 40;
  const width = positiveInt(branding.academyLogoWidth);
  const widthAttr = width ? ` width="${width}"` : '';
  const widthStyle = width ? `width:${width}px;` : '';
  return `<img src="${escapeHtml(branding.academyLogoUrl)}" alt="${escapeHtml(brand)}"${widthAttr} height="${height}" style="display:block;border:0;outline:none;text-decoration:none;height:${height}px;${widthStyle}max-width:200px;" />`;
}

/**
 * The call-to-action, as the widely used "bulletproof" button: the colour
 * and padding sit on a table cell and the link fills it (`display:block`),
 * so the WHOLE button is the tap target in every client — including
 * Outlook's Word engine, which drops padding on `<a>` and left only the
 * label's few pixels clickable — and a phone never has to hit the text
 * exactly. Same look as before. Below it, the address itself as a real
 * link (it was plain text), for a client or a reader that will not follow
 * the button.
 */
function renderCta(cta: { readonly url: string; readonly label: string }): string {
  const href = escapeHtml(cta.url);
  const button = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;border-collapse:separate;"><tr><td align="center" bgcolor="#111827" style="background:#111827;border-radius:6px;mso-padding-alt:12px 20px;"><a href="${href}" target="_blank" style="display:block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;line-height:20px;font-weight:600;">${escapeHtml(cta.label)}</a></td></tr></table>`;
  const fallback = `<p style="margin:0 0 16px 0;font-size:13px;line-height:20px;color:#6b7280;text-align:start;word-break:break-all;"><a href="${href}" target="_blank" style="color:#6b7280;text-decoration:underline;">${href}</a></p>`;
  return button + fallback;
}

export function renderHtmlLayout(
  input: LayoutInput,
  context: TemplateRenderContext,
): string {
  const dir = context.locale === 'ar' ? 'rtl' : 'ltr';
  const footer = FOOTER[context.locale];
  const brand = brandName(context);
  const logo = renderLogo(context.branding, brand);
  const paragraphs = input.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:#111827;text-align:start;">${escapeHtml(p)}</p>`,
    )
    .join('');
  const cta = input.cta ? renderCta(input.cta) : '';
  const preheader = input.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>`
    : '';

  return `<!doctype html>
<html lang="${context.locale}" dir="${dir}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans Arabic',Arial,sans-serif;" dir="${dir}">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;">
<tr><td style="padding:24px 32px 8px 32px;text-align:start;">${logo}</td></tr>
<tr><td style="padding:8px 32px 0 32px;">
<h1 style="margin:0 0 16px 0;font-size:20px;line-height:28px;font-weight:600;color:#111827;text-align:start;">${escapeHtml(input.title)}</h1>
${paragraphs}
${cta}
${input.extraHtml ?? ''}
</td></tr>
<tr><td style="padding:16px 32px 24px 32px;border-top:1px solid #e5e7eb;">
<p style="margin:0 0 6px 0;font-size:12px;line-height:18px;color:#6b7280;text-align:start;">${escapeHtml(footer.why(brand))}</p>
<p style="margin:0 0 6px 0;font-size:12px;line-height:18px;color:#6b7280;text-align:start;"><a href="${escapeHtml(context.settingsUrl)}" style="color:#374151;">${escapeHtml(footer.settings)}</a></p>
<p style="margin:0;font-size:12px;line-height:18px;color:#9ca3af;text-align:start;">${escapeHtml(footer.sentBy(context.branding.platformName))}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function renderTextLayout(
  input: LayoutInput,
  context: TemplateRenderContext,
): string {
  const footer = FOOTER[context.locale];
  const brand = brandName(context);
  const lines: string[] = [input.title, ''];
  for (const p of input.paragraphs) lines.push(p, '');
  if (input.cta) lines.push(`${input.cta.label}: ${input.cta.url}`, '');
  if (input.extraText) lines.push(input.extraText, '');
  lines.push(
    '--',
    footer.why(brand),
    `${footer.settings}: ${context.settingsUrl}`,
    footer.sentBy(context.branding.platformName),
  );
  return lines.join('\n');
}

export interface LocaleDefinition {
  readonly subject: (values: TemplateValues, context: TemplateRenderContext) => string;
  readonly preheader?: (values: TemplateValues, context: TemplateRenderContext) => string;
  readonly paragraphs: (
    values: TemplateValues,
    context: TemplateRenderContext,
  ) => string[];
  /** Label for the call-to-action; the URL is the catalogue's branded action URL. Omitted when the key has none. */
  readonly ctaLabel?: string;
}

/** Builds a `TemplateLocale` from copy alone — the layout supplies structure, escaping and the footer. */
export function defineLocale(definition: LocaleDefinition): TemplateLocale {
  const layout = (
    values: TemplateValues,
    context: TemplateRenderContext,
  ): LayoutInput => ({
    title: definition.subject(values, context),
    preheader: definition.preheader?.(values, context),
    paragraphs: definition.paragraphs(values, context),
    cta:
      definition.ctaLabel && context.actionUrl
        ? { label: definition.ctaLabel, url: context.actionUrl }
        : undefined,
  });
  return {
    subject: definition.subject,
    preheader: definition.preheader,
    text: (values, context) => renderTextLayout(layout(values, context), context),
    html: (values, context) => renderHtmlLayout(layout(values, context), context),
  };
}
