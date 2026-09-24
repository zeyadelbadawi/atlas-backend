/**
 * The daily digest — one email carrying every item that was deferred into
 * the recipient's window. `values.items` is a list of `{ subject, url }`
 * already rendered in the recipient's locale; this template only lists
 * them.
 */
import { escapeHtml, renderHtmlLayout, renderTextLayout, str } from '../layout';
import type {
  CommunicationTemplate,
  TemplateRenderContext,
  TemplateValues,
} from '../layout';

export interface DigestItem {
  readonly subject: string;
  readonly url: string | null;
}

function items(values: TemplateValues): DigestItem[] {
  const raw = values.items;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is DigestItem => typeof item === 'object' && item !== null)
    .map((item) => ({
      subject: typeof item.subject === 'string' ? item.subject : '',
      url: typeof item.url === 'string' ? item.url : null,
    }));
}

function extraHtml(values: TemplateValues): string {
  const rows = items(values)
    .map((item) => {
      const label = escapeHtml(item.subject);
      const body = item.url
        ? `<a href="${escapeHtml(item.url)}" style="color:#111827;">${label}</a>`
        : label;
      return `<li style="margin:0 0 10px 0;font-size:15px;line-height:22px;color:#111827;text-align:start;">${body}</li>`;
    })
    .join('');
  return `<ul style="margin:0 0 16px 0;padding-inline-start:20px;">${rows}</ul>`;
}

function extraText(values: TemplateValues): string {
  return items(values)
    .map((item) => (item.url ? `- ${item.subject}\n  ${item.url}` : `- ${item.subject}`))
    .join('\n');
}

const COPY = {
  en: {
    subject: (n: number) => `Your daily summary (${n} ${n === 1 ? 'update' : 'updates'})`,
    intro: (n: number, brand: string) =>
      `Here is what happened at ${brand} since your last summary — ${n} ${n === 1 ? 'update' : 'updates'}.`,
  },
  ar: {
    subject: (n: number) => `ملخصك اليومي (${n} ${n === 1 ? 'تحديث' : 'تحديثات'})`,
    intro: (n: number, brand: string) =>
      `إليك ما حدث في ${brand} منذ ملخصك الأخير — ${n} ${n === 1 ? 'تحديث' : 'تحديثات'}.`,
  },
} as const;

function build(locale: 'en' | 'ar') {
  const copy = COPY[locale];
  const layout = (values: TemplateValues, context: TemplateRenderContext) => {
    const n = items(values).length;
    const brand =
      str(values, 'brandName') ||
      context.branding.academyName ||
      context.branding.platformName;
    return {
      title: copy.subject(n),
      paragraphs: [copy.intro(n, brand)],
      extraHtml: extraHtml(values),
      extraText: extraText(values),
    };
  };
  return {
    subject: (values: TemplateValues) => copy.subject(items(values).length),
    text: (values: TemplateValues, context: TemplateRenderContext) =>
      renderTextLayout(layout(values, context), context),
    html: (values: TemplateValues, context: TemplateRenderContext) =>
      renderHtmlLayout(layout(values, context), context),
  };
}

export const template: CommunicationTemplate = {
  version: '1',
  en: build('en'),
  ar: build('ar'),
};
