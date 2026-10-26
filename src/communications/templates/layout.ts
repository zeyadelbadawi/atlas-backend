/**
 * Email layout — P64 Communications C2.
 *
 * One HTML base and one plain-text base shared by every template. The
 * HTML is a single-column, table-based card at most 600 px wide, inline
 * styles only (no `<style>` block survives every mail client), logical
 * alignment (`text-align:start`) so the same markup reads correctly under
 * `dir="rtl"`, and a footer that says why the person received the email
 * and where to change that.
 *
 * B2 — branded: a platform email carries the Atlas logo (a PNG on the
 * marketing site; Gmail renders no SVG) next to the name as real text,
 * a Royal Navy button and the company signature (website, help center,
 * contact). An academy email keeps the academy's own name and logo and a
 * neutral button. Colours are the brand tokens with every background set
 * explicitly, so a client that darkens the email keeps the contrast; the
 * Arabic layout gets an Arabic-capable font stack. No tracking pixel, no
 * remote image beyond the two logos, no marketing tone.
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
  /** B2 — the public marketing site (signature links, platform logo). Default `DEFAULT_SITE_URL`. */
  readonly siteUrl?: string;
  /** B2 — the help center. Default `DEFAULT_HELP_CENTER_URL`. */
  readonly helpCenterUrl?: string;
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
    tagline: 'The platform for running your online academy.',
    website: 'Website',
    helpCenter: 'Help center',
    contact: 'Contact us',
  },
  ar: {
    why: (brand: string) => `وصلتك هذه الرسالة لأن لديك حسابًا لدى ${brand}.`,
    settings: 'إدارة إعدادات البريد',
    sentBy: (platform: string) => `أُرسلت بواسطة ${platform}`,
    tagline: 'المنصة التي تدير بها أكاديميتك على الإنترنت.',
    website: 'الموقع',
    helpCenter: 'مركز المساعدة',
    contact: 'تواصل معنا',
  },
} as const;

/**
 * B2 — the public marketing site and help center the platform signature
 * links to. Production values are the defaults; `BrandingContext.siteUrl`
 * / `helpCenterUrl` (from `MARKETING_SITE_URL` / `HELP_CENTER_URL`)
 * override them for another deployment.
 */
export const DEFAULT_SITE_URL = 'https://atlass.dpdns.org';
export const DEFAULT_HELP_CENTER_URL = 'https://docs.atlass.dpdns.org';
/**
 * The Atlas mark as an email-safe PNG (Gmail renders no SVG): the approved
 * app icon (white "A + open book" on a Royal Navy tile), 96 px for a 48 px
 * slot, served as a static file by the marketing site. The navy tile is
 * what keeps it legible when a client darkens the email.
 */
export const PLATFORM_LOGO_PATH = '/marketing-assets/brand/atlas-mark-email-2x.png';
const PLATFORM_LOGO_SIZE = 48;

/** Brand tokens (marketing/brand/tokens-final.json, light). */
const COLOR = {
  page: '#F5F7FB',
  card: '#FFFFFF',
  text: '#0E1A33',
  muted: '#4A566E',
  border: '#DCE2EE',
  primary: '#1B3A8C',
  link: '#1B4DB8',
  accent: '#E0A526',
  /** Academy emails keep a neutral button: the academy is the brand there. */
  neutral: '#111827',
} as const;

const FONT = {
  en: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif",
  ar: "Tahoma,'Segoe UI','Noto Sans Arabic','Geeza Pro','Arabic Typesetting',Arial,sans-serif",
} as const;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

interface SiteLinks {
  readonly website: string;
  readonly helpCenter: string;
  readonly contact: string;
  readonly logo: string;
}

/** The signature's links, in the reader's language (`/ar` on both sites). */
function siteLinks(context: TemplateRenderContext): SiteLinks {
  const site = trimSlash(context.branding.siteUrl ?? DEFAULT_SITE_URL);
  const help = trimSlash(context.branding.helpCenterUrl ?? DEFAULT_HELP_CENTER_URL);
  const prefix = context.locale === 'ar' ? '/ar' : '';
  return {
    website: `${site}${prefix || '/'}`,
    helpCenter: `${help}${prefix || '/'}`,
    contact: `${site}${prefix}/contact`,
    logo: `${site}${PLATFORM_LOGO_PATH}`,
  };
}

/** A platform email (no academy identity) carries the Atlas logo and signature. */
function isPlatformEmail(context: TemplateRenderContext): boolean {
  return !context.branding.academyName;
}

export interface LayoutInput {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly preheader?: string;
  readonly cta?: { readonly label: string; readonly url: string };
  /** Extra pre-rendered HTML block placed after the paragraphs (digest lists). Already escaped by the caller. */
  readonly extraHtml?: string;
  /** Plain-text counterpart of `extraHtml`. */
  readonly extraText?: string;
  /**
   * B2 — print the platform signature without its website / help center /
   * contact links. For the sign-in code email, which carries no link at
   * all (see `auth.email.otp`).
   */
  readonly signatureWithoutLinks?: boolean;
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
 * The header brand mark. An academy email: the academy logo with explicit
 * `width`/`height` attributes (Outlook's Word engine ignores CSS sizing),
 * `alt` = the brand name, and the email-client-safe inline reset — or,
 * when there is no usable logo, the academy name as text. A `data:` URI or
 * a relative path never reaches `src`. A platform email: the Atlas mark
 * (decorative, empty alt) beside the name in text, so the brand still
 * reads, once, when images are blocked.
 */
function renderLogo(context: TemplateRenderContext, brand: string): string {
  const branding = context.branding;
  const nameStyle = `font-size:20px;line-height:28px;font-weight:700;color:${COLOR.text};`;
  if (isPlatformEmail(context)) {
    const logo = siteLinks(context).logo;
    const name = `<span style="${nameStyle}">${escapeHtml(brand)}</span>`;
    if (!isEmailSafeImageUrl(logo)) return name;
    const size = PLATFORM_LOGO_SIZE;
    // alt="" — the name is written beside it, so a blocked image (Gmail
    // blocks every image in Spam) shows the name once, not twice.
    const img = `<img src="${escapeHtml(logo)}" alt="" width="${size}" height="${size}" style="display:block;border:0;outline:none;text-decoration:none;width:${size}px;height:${size}px;border-radius:10px;" />`;
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0;vertical-align:middle;">${img}</td><td style="padding:0 12px;vertical-align:middle;">${name}</td></tr></table>`;
  }
  if (!isEmailSafeImageUrl(branding.academyLogoUrl)) {
    return `<span style="${nameStyle}">${escapeHtml(brand)}</span>`;
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
 * Outlook's Word engine, which drops padding on `<a>` — and it is at least
 * 44 px tall. Below it, the address itself as a real link, for a client or
 * a reader that will not follow the button.
 */
function renderCta(
  cta: { readonly url: string; readonly label: string },
  color: string,
): string {
  const href = escapeHtml(cta.url);
  const button = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px 0;border-collapse:separate;"><tr><td align="center" bgcolor="${color}" style="background:${color};border-radius:8px;mso-padding-alt:14px 28px;"><a href="${href}" target="_blank" style="display:block;padding:14px 28px;background:${color};color:#FFFFFF;text-decoration:none;border-radius:8px;font-size:16px;line-height:20px;font-weight:700;">${escapeHtml(cta.label)}</a></td></tr></table>`;
  const fallback = `<p style="margin:0 0 16px 0;font-size:13px;line-height:20px;color:${COLOR.muted};text-align:start;word-break:break-all;"><a href="${href}" target="_blank" style="color:${COLOR.muted};text-decoration:underline;">${href}</a></p>`;
  return button + fallback;
}

const SMALL = `margin:0 0 8px 0;font-size:13px;line-height:20px;color:${COLOR.muted};text-align:start;`;

function footerLink(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" target="_blank" style="color:${COLOR.link};text-decoration:underline;">${escapeHtml(label)}</a>`;
}

/** The company signature (platform emails) or the academy footer, then why + settings. */
function renderFooterHtml(
  context: TemplateRenderContext,
  brand: string,
  withLinks: boolean,
): string {
  const footer = FOOTER[context.locale];
  const why = `<p style="${SMALL}">${escapeHtml(footer.why(brand))}</p>`;
  const settings = `<p style="${SMALL}">${footerLink(context.settingsUrl, footer.settings)}</p>`;
  if (!isPlatformEmail(context)) {
    return `${why}${settings}<p style="${SMALL}margin:0;">${escapeHtml(footer.sentBy(context.branding.platformName))}</p>`;
  }
  const links = siteLinks(context);
  const sep = `<span style="color:${COLOR.border};">&nbsp;|&nbsp;</span>`;
  return [
    `<p style="margin:0 0 2px 0;font-size:14px;line-height:20px;font-weight:700;color:${COLOR.text};text-align:start;">${escapeHtml(context.branding.platformName)}</p>`,
    `<p style="${SMALL}">${escapeHtml(footer.tagline)}</p>`,
    withLinks
      ? `<p style="margin:0 0 16px 0;font-size:13px;line-height:20px;text-align:start;">${footerLink(links.website, footer.website)}${sep}${footerLink(links.helpCenter, footer.helpCenter)}${sep}${footerLink(links.contact, footer.contact)}</p>`
      : '',
    why,
    settings.replace('margin:0 0 8px 0', 'margin:0'),
  ].join('\n');
}

export function renderHtmlLayout(
  input: LayoutInput,
  context: TemplateRenderContext,
): string {
  const dir = context.locale === 'ar' ? 'rtl' : 'ltr';
  const brand = brandName(context);
  const platform = isPlatformEmail(context);
  const logo = renderLogo(context, brand);
  const font = FONT[context.locale];
  const paragraphs = input.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px 0;font-size:16px;line-height:26px;color:${COLOR.text};text-align:start;">${escapeHtml(p)}</p>`,
    )
    .join('');
  const cta = input.cta
    ? renderCta(input.cta, platform ? COLOR.primary : COLOR.neutral)
    : '';
  const preheader = input.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.preheader)}</div>`
    : '';
  // A thin gold rule under the platform header — the brand accent, never text.
  const accent = platform
    ? `<tr><td bgcolor="${COLOR.card}" style="padding:0 32px;background:${COLOR.card};"><div style="height:3px;line-height:3px;font-size:0;width:48px;background:${COLOR.accent};">&nbsp;</div></td></tr>`
    : '';

  return `<!doctype html>
<html lang="${context.locale}" dir="${dir}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:${COLOR.page};font-family:${font};" dir="${dir}" bgcolor="${COLOR.page}">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLOR.page}" style="background:${COLOR.page};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLOR.card}" style="max-width:600px;width:100%;background:${COLOR.card};border:1px solid ${COLOR.border};border-radius:12px;font-family:${font};">
<tr><td bgcolor="${COLOR.card}" style="padding:28px 32px 16px 32px;text-align:start;background:${COLOR.card};border-radius:12px 12px 0 0;">${logo}</td></tr>
${accent}
<tr><td bgcolor="${COLOR.card}" style="padding:20px 32px 8px 32px;background:${COLOR.card};">
<h1 style="margin:0 0 16px 0;font-size:22px;line-height:30px;font-weight:700;color:${COLOR.text};text-align:start;">${escapeHtml(input.title)}</h1>
${paragraphs}
${cta}
${input.extraHtml ?? ''}
</td></tr>
<tr><td bgcolor="${COLOR.page}" style="padding:20px 32px 24px 32px;background:${COLOR.page};border-top:1px solid ${COLOR.border};border-radius:0 0 12px 12px;">
${renderFooterHtml(context, brand, !input.signatureWithoutLinks)}
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
  lines.push('--');
  if (isPlatformEmail(context)) {
    const links = siteLinks(context);
    lines.push(context.branding.platformName, footer.tagline);
    if (!input.signatureWithoutLinks) {
      lines.push(
        `${footer.website}: ${links.website}`,
        `${footer.helpCenter}: ${links.helpCenter}`,
        `${footer.contact}: ${links.contact}`,
      );
    }
    lines.push('', footer.why(brand), `${footer.settings}: ${context.settingsUrl}`);
  } else {
    lines.push(
      footer.why(brand),
      `${footer.settings}: ${context.settingsUrl}`,
      footer.sentBy(context.branding.platformName),
    );
  }
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
  /** See `LayoutInput.signatureWithoutLinks`. */
  readonly signatureWithoutLinks?: boolean;
}

/** Platform emails go to academies in Egypt; dates are shown on Cairo time and say so. */
const EMAIL_TIME_ZONE = 'Africa/Cairo';
const INSTANT_VALUE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) UTC$/;
const DAY_VALUE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CAIRO_TIME = { en: ' (Cairo time)', ar: ' (بتوقيت القاهرة)' } as const;

/** False when the parts rolled over (month 13, 31 February, 24:60): not a real date. */
function isExactUtc(
  at: Date,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): boolean {
  return (
    at.getUTCFullYear() === y &&
    at.getUTCMonth() === mo - 1 &&
    at.getUTCDate() === d &&
    at.getUTCHours() === h &&
    at.getUTCMinutes() === mi
  );
}

/**
 * A `…Date` value in the email's language: `2026-11-06 23:35 UTC` (the
 * services' `formatLifecycleInstant`) becomes "7 November 2026 at 01:35
 * (Cairo time)" / "7 نوفمبر 2026 في 1:35 ص (بتوقيت القاهرة)"; a bare
 * `2026-11-06` becomes the calendar day. Arabic keeps Latin digits, like the
 * dashboard. Anything else is returned unchanged.
 */
export function formatEmailDate(value: string, locale: CommunicationLocale): string {
  const tag = locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB';
  const instant = INSTANT_VALUE.exec(value);
  if (instant) {
    const [, y, mo, d, h, mi] = instant.map(Number);
    const at = new Date(Date.UTC(y, mo - 1, d, h, mi));
    if (!isExactUtc(at, y, mo, d, h, mi)) return value;
    const text = new Intl.DateTimeFormat(tag, {
      timeZone: EMAIL_TIME_ZONE,
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(at);
    return `${text}${CAIRO_TIME[locale === 'ar' ? 'ar' : 'en']}`;
  }
  const day = DAY_VALUE.exec(value);
  if (day) {
    const [, y, mo, d] = day.map(Number);
    const at = new Date(Date.UTC(y, mo - 1, d));
    if (!isExactUtc(at, y, mo, d, 0, 0)) return value;
    return new Intl.DateTimeFormat(tag, { timeZone: 'UTC', dateStyle: 'long' }).format(
      at,
    );
  }
  return value;
}

/** Every `…Date` string value, formatted for the email's language (see `formatEmailDate`). */
function localizeDates(
  values: TemplateValues,
  locale: CommunicationLocale,
): TemplateValues {
  let out: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(values)) {
    if (!key.endsWith('Date') || typeof value !== 'string') continue;
    const formatted = formatEmailDate(value, locale);
    if (formatted === value) continue;
    out ??= { ...values };
    out[key] = formatted;
  }
  return out ?? values;
}

/** Builds a `TemplateLocale` from copy alone — the layout supplies structure, escaping and the footer. */
export function defineLocale(definition: LocaleDefinition): TemplateLocale {
  const subject = (values: TemplateValues, context: TemplateRenderContext): string =>
    definition.subject(localizeDates(values, context.locale), context);
  const preheader = definition.preheader
    ? (values: TemplateValues, context: TemplateRenderContext): string =>
        definition.preheader!(localizeDates(values, context.locale), context)
    : undefined;
  const layout = (
    values: TemplateValues,
    context: TemplateRenderContext,
  ): LayoutInput => ({
    title: subject(values, context),
    preheader: preheader?.(values, context),
    paragraphs: definition.paragraphs(localizeDates(values, context.locale), context),
    cta:
      definition.ctaLabel && context.actionUrl
        ? { label: definition.ctaLabel, url: context.actionUrl }
        : undefined,
    signatureWithoutLinks: definition.signatureWithoutLinks,
  });
  return {
    subject,
    preheader,
    text: (values, context) => renderTextLayout(layout(values, context), context),
    html: (values, context) => renderHtmlLayout(layout(values, context), context),
  };
}
