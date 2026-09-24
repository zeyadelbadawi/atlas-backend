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
  readonly academyLogoUrl?: string;
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
  if (typeof value === 'string') return value;
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

export function renderHtmlLayout(
  input: LayoutInput,
  context: TemplateRenderContext,
): string {
  const dir = context.locale === 'ar' ? 'rtl' : 'ltr';
  const footer = FOOTER[context.locale];
  const brand = brandName(context);
  const logo = context.branding.academyLogoUrl
    ? `<img src="${escapeHtml(context.branding.academyLogoUrl)}" alt="${escapeHtml(brand)}" height="40" style="height:40px;max-height:40px;border:0;display:block;" />`
    : `<span style="font-size:18px;font-weight:600;color:#111827;">${escapeHtml(brand)}</span>`;
  const paragraphs = input.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px 0;font-size:16px;line-height:24px;color:#111827;text-align:start;">${escapeHtml(p)}</p>`,
    )
    .join('');
  const cta = input.cta
    ? `<p style="margin:8px 0 24px 0;text-align:start;"><a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:12px 20px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:600;">${escapeHtml(input.cta.label)}</a></p><p style="margin:0 0 16px 0;font-size:13px;line-height:20px;color:#6b7280;text-align:start;word-break:break-all;">${escapeHtml(input.cta.url)}</p>`
    : '';
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
