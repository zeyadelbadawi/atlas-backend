/**
 * B1 F.5 — the cookieless marketing beacon's CLOSED vocabularies.
 *
 * Everything a browser may report about a visit to the Atlas marketing
 * website is listed here, and nothing else is ever stored: an unknown
 * event name, page template, locale, device or value drops the event. No
 * field can carry a URL, a query string, an id or free text, so a hostile
 * reporter can skew counts but cannot grow the table with personal data.
 *
 * The frontend mirrors these lists in `src/marketing/client/beacon.ts` and
 * (help center, DL-57) `src/docs/client/beacon.ts`.
 */

export const MKT_EVENT_NAMES = [
  'page_viewed',
  'section_viewed',
  'faq_expanded',
  'language_switched',
  'cta_clicked',
  'billing_toggle_changed',
  'contact_form_started',
  'contact_form_submitted',
  'campaign_landing',
  // Help center (docs.<base>, DL-57). Never the query text or the article.
  'docs_search_used',
  'docs_helpful',
] as const;
export type MktEventName = (typeof MKT_EVENT_NAMES)[number];

/** Page TEMPLATES (`<body data-mkt-page>`), never a path. */
export const MKT_PAGES = [
  'mkt:home',
  'mkt:features',
  'mkt:pricing',
  'mkt:contact',
  'mkt:security',
  'mkt:about',
  'mkt:legal',
  'mkt:404',
  // Help center page templates (DL-57).
  'docs:home',
  'docs:category',
  'docs:article',
  'docs:search',
  'docs:404',
  'other',
] as const;
export type MktPage = (typeof MKT_PAGES)[number];

export const MKT_LOCALES = ['en', 'ar'] as const;
export type MktLocale = (typeof MKT_LOCALES)[number];

/** The 767 px rule, as RUM. */
export const MKT_DEVICES = ['mobile', 'desktop'] as const;
export type MktDevice = (typeof MKT_DEVICES)[number];

/**
 * `data-mkt-section` ids: the SPEC's numbered home sections (`s1_hero` …
 * `s14_closing`) plus the generic section anchors the marketing pages
 * render today. A section id not listed here drops its event.
 */
export const MKT_SECTIONS = [
  's1_hero',
  's14_closing',
  'closing',
  'payments',
  'website',
  'team',
  'assessments',
  'students',
  'languages',
  'how-it-works',
  'faq',
  'pricing',
  'trial',
  'limits',
  'honest-limits',
  'not-yet',
  'lessons',
  'roles',
  'separation',
  'sign-in',
  'stored-data',
  'privacy-requests',
] as const;

export const MKT_CTAS = ['cta_t', 'cta_c', 'cta_pricing'] as const;
export const MKT_BILLING = ['monthly', 'yearly'] as const;
/** FAQ entries are reported by their 1-based position on the page. */
export const MKT_FAQ_INDEXES = Array.from({ length: 20 }, (_, i) => String(i + 1));

/**
 * The `value` each event may carry. Events listed with a vocabulary
 * REQUIRE a value from it; events listed as `null` carry none (anything
 * sent is ignored, stored as '').
 */
export const MKT_EVENT_VALUES: Record<MktEventName, readonly string[] | null> = {
  page_viewed: null,
  section_viewed: MKT_SECTIONS,
  faq_expanded: MKT_FAQ_INDEXES,
  language_switched: MKT_LOCALES,
  cta_clicked: MKT_CTAS,
  billing_toggle_changed: MKT_BILLING,
  contact_form_started: null,
  contact_form_submitted: null,
  campaign_landing: null,
  docs_search_used: ['results', 'no_results'],
  docs_helpful: ['yes', 'no'],
};

/**
 * Events a single page load produces at most once: a batch reporting one
 * of them several times counts it once (the others count every report).
 * `section_viewed` is once per section, enforced by its value.
 */
export const MKT_ONCE_PER_BATCH: ReadonlySet<MktEventName> = new Set([
  'page_viewed',
  'campaign_landing',
  'contact_form_started',
  'contact_form_submitted',
  'section_viewed',
  'docs_helpful',
]);

/**
 * The campaign REGISTER (SPEC P-CAMPAIGN). A UTM value is stored only when
 * it is registered here (compared lowercased and trimmed); any other value
 * is stored as `unregistered`, and a missing one as ''. Add a campaign here
 * before it runs — the register is the only way a new value is counted.
 */
export const MKT_UTM_REGISTER = {
  utm_source: [
    'google',
    'bing',
    'facebook',
    'instagram',
    'linkedin',
    'x',
    'youtube',
    'tiktok',
    'whatsapp',
    'newsletter',
    'email',
  ],
  utm_medium: [
    'cpc',
    'paid_social',
    'social',
    'organic_social',
    'email',
    'referral',
    'display',
    'partner',
    'qr',
  ],
  utm_campaign: ['m1a_launch', 'brand', 'retargeting'],
} as const satisfies Record<string, readonly string[]>;
export type MktUtmField = keyof typeof MKT_UTM_REGISTER;
export const MKT_UNREGISTERED = 'unregistered';

/** A beacon reports at most this many events (the client flushes at 10). */
export const MAX_EVENTS_PER_BEACON = 20;
export const MAX_REFERRER_DOMAIN_LENGTH = 100;

/** Aggregate rows are kept this long (SPEC F.5 "25 months [proposal]"). */
export const MKT_RETENTION_MONTHS = 25;

/** Per client (IPv4 address or IPv6 /64), held only by the throttler. */
export const MKT_EVENTS_THROTTLE_LIMIT = 60;
export const MKT_EVENTS_THROTTLE_TTL_MS = 60_000;

export const MKT_RETENTION_QUEUE = 'marketing-events-retention';
export const MKT_RETENTION_JOB = 'prune';
export const MKT_RETENTION_REPEAT_JOB_ID = 'marketing-events-retention-repeat';
export const MKT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
