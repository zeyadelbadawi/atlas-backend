/**
 * W3-compose — the shared shape of a person-authored message email
 * (`academy.message.sent`, `platform.broadcast.sent`).
 *
 * The author's subject and body are NOT in `values` on the outbox row:
 * the dispatcher loads them from `communication_campaigns` by the row's
 * `campaign_id` just before rendering (one copy of the body per campaign,
 * not one per recipient). What reaches this template is:
 *
 *   - `campaignSubject`       — plain text, already length-capped;
 *   - `campaignBodyHtml`      — allowlist HTML from `sanitizeRichText`. It
 *                               is sanitised AGAIN here: the render never
 *                               trusts what a database row says it is
 *                               (once per distinct body, memoised — see
 *                               `campaignBodyEmailHtml`);
 *   - `campaignBodyText`      — the plain-text twin;
 *   - `campaignContentLocale` — the language the author wrote in, which sets the
 *                        body block's direction independently of the
 *                        recipient's own chrome language;
 *   - `unsubscribeUrl`        — the one-click opt-out for this category.
 *
 * The keys are namespaced (`campaign*`) so they can never collide with a
 * generic `subject` some other producer put in `values`.
 *
 * The layout (logo, footer, escaping, `dir`) is the shared one — the same
 * `renderHtmlLayout` every other email uses.
 */
import { escapeHtml, renderHtmlLayout, renderTextLayout, str } from '../layout';
import type {
  CommunicationTemplate,
  TemplateLocale,
  TemplateRenderContext,
  TemplateValues,
} from '../layout';
import { sanitizeRichText, styleForEmail } from '../../campaigns/rich-text-sanitizer';

interface CampaignCopy {
  readonly fallbackSubject: (brand: string) => string;
  readonly preheader: (brand: string) => string;
  readonly unsubscribeLead: string;
  readonly unsubscribeLabel: string;
}

export const CAMPAIGN_COPY: Readonly<
  Record<'academy' | 'platform', Readonly<Record<'en' | 'ar', CampaignCopy>>>
> = {
  academy: {
    en: {
      fallbackSubject: (brand) => `A message from ${brand}`,
      preheader: (brand) => `A message from ${brand}.`,
      unsubscribeLead: 'You received this message because you are part of this academy.',
      unsubscribeLabel: 'Unsubscribe from academy messages',
    },
    ar: {
      fallbackSubject: (brand) => `رسالة من ${brand}`,
      preheader: (brand) => `رسالة من ${brand}.`,
      unsubscribeLead: 'وصلتك هذه الرسالة لأنك عضو في هذه الأكاديمية.',
      unsubscribeLabel: 'إلغاء الاشتراك في رسائل الأكاديمية',
    },
  },
  platform: {
    en: {
      fallbackSubject: (brand) => `An update from ${brand}`,
      preheader: (brand) => `An update from the ${brand} team.`,
      unsubscribeLead:
        'You received this update because you manage an organization or academy.',
      unsubscribeLabel: 'Unsubscribe from platform updates',
    },
    ar: {
      fallbackSubject: (brand) => `تحديث من ${brand}`,
      preheader: (brand) => `تحديث من فريق ${brand}.`,
      unsubscribeLead: 'وصلك هذا التحديث لأنك تدير مؤسسة أو أكاديمية.',
      unsubscribeLabel: 'إلغاء الاشتراك في تحديثات المنصة',
    },
  },
};

/**
 * The styled, re-sanitised body, rendered ONCE per campaign body rather than
 * once per recipient (security review finding 3: a campaign renders the
 * same body for every recipient, and re-sanitising it each time multiplied
 * the work by the audience). Keyed by the stored body itself, so the
 * "never trust the row" re-sanitisation is kept — it simply is not repeated
 * for identical input. Nothing per-recipient is in the body (the
 * unsubscribe link is added outside it). Bounded: a few recent bodies,
 * oversized ones not cached.
 */
const BODY_CACHE_MAX_ENTRIES = 16;
const BODY_CACHE_MAX_INPUT = 100_000;
const bodyHtmlCache = new Map<string, string>();

export function campaignBodyEmailHtml(rawBodyHtml: string): string {
  const cached = bodyHtmlCache.get(rawBodyHtml);
  if (cached !== undefined) {
    // Refresh recency (Map iteration order is insertion order).
    bodyHtmlCache.delete(rawBodyHtml);
    bodyHtmlCache.set(rawBodyHtml, cached);
    return cached;
  }
  const html = styleForEmail(sanitizeRichText(rawBodyHtml).html);
  if (rawBodyHtml.length <= BODY_CACHE_MAX_INPUT) {
    bodyHtmlCache.set(rawBodyHtml, html);
    while (bodyHtmlCache.size > BODY_CACHE_MAX_ENTRIES) {
      const oldest = bodyHtmlCache.keys().next().value;
      if (oldest === undefined) break;
      bodyHtmlCache.delete(oldest);
    }
  }
  return html;
}

function brandOf(context: TemplateRenderContext): string {
  return context.branding.academyName ?? context.branding.platformName;
}

function bodyBlock(
  values: TemplateValues,
  locale: 'en' | 'ar',
  copy: CampaignCopy,
): string {
  const html = campaignBodyEmailHtml(str(values, 'campaignBodyHtml'));
  const contentLocale = str(values, 'campaignContentLocale') === 'ar' ? 'ar' : 'en';
  const dir = contentLocale === 'ar' ? 'rtl' : 'ltr';
  const unsubscribeUrl = str(values, 'unsubscribeUrl');
  const unsubscribe = unsubscribeUrl
    ? `<p style="margin:24px 0 0 0;font-size:12px;line-height:18px;color:#6b7280;text-align:start;" dir="${locale === 'ar' ? 'rtl' : 'ltr'}">${escapeHtml(copy.unsubscribeLead)} <a href="${escapeHtml(unsubscribeUrl)}" style="color:#374151;">${escapeHtml(copy.unsubscribeLabel)}</a></p>`
    : '';
  const body = html
    ? `<div dir="${dir}" lang="${contentLocale}" style="text-align:start;">${html}</div>`
    : '';
  return `${body}${unsubscribe}`;
}

function textBlock(values: TemplateValues, copy: CampaignCopy): string {
  const lines = [str(values, 'campaignBodyText')];
  const unsubscribeUrl = str(values, 'unsubscribeUrl');
  if (unsubscribeUrl) {
    lines.push('', copy.unsubscribeLead, `${copy.unsubscribeLabel}: ${unsubscribeUrl}`);
  }
  return lines.join('\n').trim();
}

function build(kind: 'academy' | 'platform', locale: 'en' | 'ar'): TemplateLocale {
  const copy = CAMPAIGN_COPY[kind][locale];
  const subject = (values: TemplateValues, context: TemplateRenderContext) =>
    str(values, 'campaignSubject', copy.fallbackSubject(brandOf(context)));
  const layout = (values: TemplateValues, context: TemplateRenderContext) => ({
    title: subject(values, context),
    preheader: copy.preheader(brandOf(context)),
    paragraphs: [],
    extraHtml: bodyBlock(values, locale, copy),
    extraText: textBlock(values, copy),
  });
  return {
    subject,
    preheader: (_values, context) => copy.preheader(brandOf(context)),
    text: (values, context) => renderTextLayout(layout(values, context), context),
    html: (values, context) => renderHtmlLayout(layout(values, context), context),
  };
}

export function campaignTemplate(kind: 'academy' | 'platform'): CommunicationTemplate {
  return { version: '1', en: build(kind, 'en'), ar: build(kind, 'ar') };
}
