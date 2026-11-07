/**
 * An Academy's own `/llms.txt` and `/llms-full.txt` (SEO/AEO/GEO pass,
 * Nov 2026) — the llms.txt proposal (https://llmstxt.org): a Markdown
 * file at the site root that tells an AI assistant, in one read, what the
 * site is and where its pages are.
 *
 *   # <Academy name>                       (the only required part)
 *   > <one-line summary>                   (blockquote)
 *   <details>                              (paragraphs, no headings)
 *   ## Pages / ## Courses                  (link lists: "- [name](url): notes")
 *   ## Optional                            (links an agent may skip)
 *
 * `llms-full.txt` (a common companion, not part of the proposal) carries
 * the same header and, in full, what the pages say: each page's opening
 * text, every FAQ answer, every course's description, outcomes and
 * requirements — so an answer engine can quote the Academy without
 * rendering a page.
 *
 * Pure functions, fed only PUBLISHED content (the same reads the public
 * site and the sitemap use): visible, indexable pages and published public
 * courses, in the site's default language with links to the other.
 * Nothing here is served unless the site is published and indexable.
 */
import {
  PUBLIC_WEBSITE_LOCALES,
  type PublicWebsiteLocale,
} from '../../website/constants/locale.constants';
import {
  resolveLocalizedText,
  type LocalizedTextLike,
} from '../../website/utils/localized-text.util';
import { localizedSitePath, publicPagePath } from './seo-files.util';

export interface LlmsPage {
  readonly id?: string;
  readonly pageType: string;
  readonly coreType?: string | null;
  readonly title: string;
  readonly slug: string;
  readonly visible: boolean;
  readonly seo?: Record<string, unknown> | null;
  readonly sections?: readonly unknown[];
}

export interface LlmsCourse {
  readonly title: string;
  readonly slug: string;
  readonly status: string;
  readonly visibility: string;
  readonly shortDescription?: string;
  readonly description?: string;
  readonly level?: string | null;
  readonly language?: string;
  readonly pricing?: {
    readonly type: string;
    readonly amount?: number;
    readonly currency?: string;
  };
  readonly outcomes?: readonly string[];
  readonly requirements?: readonly string[];
  readonly instructors?: readonly { readonly name: string }[];
  readonly category?: { readonly name: string } | null;
}

export interface LlmsNavigationItem {
  readonly pageId: string;
  readonly label: LocalizedTextLike | string;
}

export interface LlmsTxtInput {
  /** The canonical origin, e.g. `https://horizon.atlass.dpdns.org`. */
  readonly origin: string;
  readonly academyName: string;
  readonly academyDescription?: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
  readonly defaultLocale: PublicWebsiteLocale;
  readonly pages: readonly LlmsPage[];
  readonly courses: readonly LlmsCourse[];
  readonly navigation?: readonly LlmsNavigationItem[];
  /** The site's own meta description (`configuration.seo.metaDescription`). */
  readonly siteDescription?: LocalizedTextLike | string;
  readonly sitemapEnabled: boolean;
}

/** Core pages' names when the navigation does not name them (`CORE_PAGE_DEFAULTS`). */
const CORE_PAGE_NAMES: Record<string, Record<PublicWebsiteLocale, string>> = {
  home: { en: 'Home', ar: 'الرئيسية' },
  about: { en: 'About', ar: 'من نحن' },
  courses: { en: 'Courses', ar: 'الدورات' },
  faqs: { en: 'FAQs', ar: 'الأسئلة الشائعة' },
  contact: { en: 'Contact', ar: 'تواصل معنا' },
};

const LANGUAGE_NAMES: Record<PublicWebsiteLocale, string> = {
  en: 'English',
  ar: 'Arabic (العربية)',
};

/** At most this many courses are listed (a catalogue larger than that is in the sitemap). */
export const LLMS_MAX_COURSES = 500;
const SHORT_TEXT = 300;
const LONG_TEXT = 4000;

/** One line of plain text: tags dropped, whitespace collapsed, Markdown link syntax neutralised. */
function inline(value: string | undefined, max = SHORT_TEXT): string {
  const text = (value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[[\]]/g, (char) => (char === '[' ? '(' : ')'))
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * Paragraph text: line breaks kept, a line that would start a Markdown
 * heading escaped — an ATX `#` or a setext underline (`===` / `---`) that
 * would turn the line above into a heading.
 */
function block(value: string | undefined, max = LONG_TEXT): string {
  const text = (value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]+/g, ' ')
        .trim()
        .replace(/^#/, '\\#')
        .replace(/^(=+|-+)$/, '\\$1'),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isIndexablePage(page: LlmsPage): boolean {
  return page.visible && page.seo?.indexable !== false && !!publicPagePath(page);
}

function sectionConfigs(
  page: LlmsPage,
): Array<{ type?: string; config: Record<string, unknown> }> {
  return (page.sections ?? [])
    .filter(
      (section): section is Record<string, unknown> =>
        !!section && typeof section === 'object',
    )
    .filter((section) => section.visible !== false)
    .map((section) => ({
      type: typeof section.type === 'string' ? section.type : undefined,
      config:
        section.config && typeof section.config === 'object'
          ? (section.config as Record<string, unknown>)
          : {},
    }));
}

function localized(value: unknown, locale: PublicWebsiteLocale): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return resolveLocalizedText(value as LocalizedTextLike, locale);
  }
  return '';
}

/** The page's opening sentence (hero / page header description), as the public page's own meta description default uses. */
export function pageSummary(page: LlmsPage, locale: PublicWebsiteLocale): string {
  const own = localized(page.seo?.metaDescription, locale);
  if (own) return own;
  for (const { config } of sectionConfigs(page)) {
    for (const field of ['description', 'subtitle', 'body', 'text']) {
      const text = localized(config[field], locale).trim();
      if (text && !text.includes('{{')) return text;
    }
  }
  return '';
}

/** Every question and answer the page's FAQ sections show (library entries first, then inline, cut to `maxItems`). */
export function pageFaqs(
  page: LlmsPage,
  locale: PublicWebsiteLocale,
): ReadonlyArray<{ question: string; answer: string }> {
  const seen = new Set<string>();
  const out: Array<{ question: string; answer: string }> = [];
  for (const { type, config } of sectionConfigs(page)) {
    if (type !== 'faq') continue;
    const entries = [
      ...(Array.isArray(config.libraryEntries) ? config.libraryEntries : []),
      ...(Array.isArray(config.items) ? config.items : []),
    ] as Array<Record<string, unknown>>;
    const max = typeof config.maxItems === 'number' ? config.maxItems : undefined;
    for (const entry of entries.slice(0, max)) {
      const question = inline(localized(entry?.question, locale));
      const answer = block(localized(entry?.answer, locale), 2000);
      if (!question || !answer || seen.has(question)) continue;
      seen.add(question);
      out.push({ question, answer });
    }
  }
  return out;
}

function pageName(
  page: LlmsPage,
  locale: PublicWebsiteLocale,
  navigation: readonly LlmsNavigationItem[],
): string {
  const label = page.id
    ? navigation.find((item) => item.pageId === page.id)?.label
    : undefined;
  const fromNavigation = label ? inline(localized(label, locale)) : '';
  if (fromNavigation) return fromNavigation;
  if (page.coreType && CORE_PAGE_NAMES[page.coreType]) {
    return CORE_PAGE_NAMES[page.coreType][locale];
  }
  return inline(page.title) || page.slug;
}

function publicCourses(courses: readonly LlmsCourse[]): readonly LlmsCourse[] {
  return courses
    .filter((course) => course.status === 'published' && course.visibility === 'public')
    .slice(0, LLMS_MAX_COURSES);
}

function coursePrice(course: LlmsCourse): string {
  if (!course.pricing) return '';
  if (course.pricing.type !== 'paid') return 'Free';
  return course.pricing.amount != null && course.pricing.currency
    ? `${course.pricing.amount} ${course.pricing.currency}`
    : 'Paid';
}

function courseFacts(course: LlmsCourse): string {
  return [
    course.level ? `Level: ${course.level}` : '',
    coursePrice(course) ? `Price: ${coursePrice(course)}` : '',
    course.language ? `Language: ${course.language}` : '',
    course.category?.name ? `Category: ${inline(course.category.name)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function header(input: LlmsTxtInput): string[] {
  const { defaultLocale } = input;
  const summary =
    inline(localized(input.siteDescription, defaultLocale)) ||
    inline(input.academyDescription) ||
    `${inline(input.academyName)} offers online courses.`;
  const languages = [
    defaultLocale,
    ...PUBLIC_WEBSITE_LOCALES.filter((locale) => locale !== defaultLocale),
  ];
  const lines = [`# ${inline(input.academyName) || 'Academy'}`, '', `> ${summary}`, ''];
  const description = inline(input.academyDescription, 1000);
  if (description && description !== summary) lines.push(description, '');
  lines.push(
    `The website is published in ${languages.map((locale) => LANGUAGE_NAMES[locale]).join(' and ')}. ` +
      `Every page is available at its unprefixed path in ${LANGUAGE_NAMES[defaultLocale]} ` +
      `and under ${languages
        .slice(1)
        .map((locale) => `\`/${locale}\``)
        .join(', ')} in the other language.`,
  );
  const contact = [
    input.contactEmail ? `email ${inline(input.contactEmail)}` : '',
    input.contactPhone ? `phone ${inline(input.contactPhone)}` : '',
  ].filter(Boolean);
  if (contact.length) lines.push('', `Contact: ${contact.join(', ')}.`);
  lines.push('');
  return lines;
}

function url(input: LlmsTxtInput, path: string, locale = input.defaultLocale): string {
  return `${input.origin}${localizedSitePath(path, locale, input.defaultLocale)}`;
}

/** `/llms.txt`: what the site is, its pages and its courses, as links. */
export function buildLlmsTxt(input: LlmsTxtInput): string {
  const { defaultLocale } = input;
  const navigation = input.navigation ?? [];
  const pages = input.pages.filter(isIndexablePage);
  const courses = publicCourses(input.courses);
  const lines = header(input);

  if (pages.length) {
    lines.push('## Pages', '');
    for (const page of pages) {
      const path = publicPagePath(page)!;
      const notes = inline(pageSummary(page, defaultLocale), 200);
      lines.push(
        `- [${pageName(page, defaultLocale, navigation)}](${url(input, path)})${notes ? `: ${notes}` : ''}`,
      );
    }
    lines.push('');
  }

  if (courses.length) {
    lines.push('## Courses', '');
    for (const course of courses) {
      const facts = courseFacts(course);
      const description = inline(course.shortDescription || course.description, 200);
      const notes = [description, facts ? `(${facts})` : ''].filter(Boolean).join(' ');
      lines.push(
        `- [${inline(course.title)}](${url(input, `/courses/${encodeURIComponent(course.slug)}`)})${notes ? `: ${notes}` : ''}`,
      );
    }
    lines.push('');
  }

  lines.push('## Optional', '');
  lines.push(
    `- [Full text of this site for AI assistants](${input.origin}/llms-full.txt)`,
  );
  for (const locale of PUBLIC_WEBSITE_LOCALES) {
    if (locale === defaultLocale) continue;
    lines.push(`- [${LANGUAGE_NAMES[locale]} version](${url(input, '/', locale)})`);
  }
  if (input.sitemapEnabled) lines.push(`- [Sitemap](${input.origin}/sitemap.xml)`);
  lines.push('');
  return lines.join('\n');
}

/** `/llms-full.txt`: the same header, then what each page, FAQ and course says, in full. */
export function buildLlmsFullTxt(input: LlmsTxtInput): string {
  const { defaultLocale } = input;
  const navigation = input.navigation ?? [];
  const pages = input.pages.filter(isIndexablePage);
  const courses = publicCourses(input.courses);
  const lines = header(input);

  for (const page of pages) {
    const path = publicPagePath(page)!;
    lines.push(
      `## ${pageName(page, defaultLocale, navigation)}`,
      '',
      `URL: ${url(input, path)}`,
      '',
    );
    const summary = block(pageSummary(page, defaultLocale), 1500);
    if (summary) lines.push(summary, '');
    const faqs = pageFaqs(page, defaultLocale);
    for (const faq of faqs) {
      lines.push(`### ${faq.question}`, '', faq.answer, '');
    }
  }

  if (courses.length) {
    lines.push('## Courses', '');
    for (const course of courses) {
      lines.push(
        `### ${inline(course.title)}`,
        '',
        `URL: ${url(input, `/courses/${encodeURIComponent(course.slug)}`)}`,
      );
      const facts = courseFacts(course);
      if (facts) lines.push(facts);
      const instructors = (course.instructors ?? [])
        .map((i) => inline(i.name))
        .filter(Boolean);
      if (instructors.length) lines.push(`Instructors: ${instructors.join(', ')}`);
      lines.push('');
      const description = block(course.description || course.shortDescription);
      if (description) lines.push(description, '');
      const outcomes = (course.outcomes ?? []).map((o) => inline(o)).filter(Boolean);
      if (outcomes.length) {
        lines.push('What you will learn:', '', ...outcomes.map((o) => `- ${o}`), '');
      }
      const requirements = (course.requirements ?? [])
        .map((r) => inline(r))
        .filter(Boolean);
      if (requirements.length) {
        lines.push('Requirements:', '', ...requirements.map((r) => `- ${r}`), '');
      }
    }
  }
  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
