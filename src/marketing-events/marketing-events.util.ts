/**
 * B1 F.5 — parsing and scrubbing for `POST /mkt/events`.
 *
 * The beacon is unauthenticated and therefore hostile input. Like RUM's
 * `parseVitalsBeacon`, only closed vocabularies survive
 * (`marketing-events.vocabulary.ts`); every unknown name, page, locale,
 * device or value DROPS the event — it is never stored as "other". Extra
 * fields are ignored. Campaign values are mapped onto the register, and the
 * referrer is reduced to a bare hostname or nothing.
 */
import {
  MAX_EVENTS_PER_BEACON,
  MAX_REFERRER_DOMAIN_LENGTH,
  MKT_DEVICES,
  MKT_EVENT_NAMES,
  MKT_EVENT_VALUES,
  MKT_LOCALES,
  MKT_ONCE_PER_BATCH,
  MKT_PAGES,
  MKT_UNREGISTERED,
  MKT_UTM_REGISTER,
  type MktDevice,
  type MktEventName,
  type MktLocale,
  type MktPage,
  type MktUtmField,
} from './marketing-events.vocabulary';

export interface MarketingEvent {
  readonly name: MktEventName;
  readonly page: MktPage;
  readonly locale: MktLocale;
  readonly device: MktDevice;
  /** From the event's own closed list, or '' for events without one. */
  readonly value: string;
  /** `campaign_landing` only ('' otherwise): a registered value, `unregistered`, or ''. */
  readonly utmSource: string;
  readonly utmMedium: string;
  readonly utmCampaign: string;
  /** `campaign_landing` only: a bare hostname, or ''. */
  readonly referrerDomain: string;
}

/** One aggregate increment: the dimensions of a daily row plus how many to add. */
export interface MarketingEventIncrement extends MarketingEvent {
  readonly count: number;
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/**
 * Crawlers, link previewers, headless browsers, audit tools and HTTP
 * libraries. A missing User-Agent counts as a bot too: every real browser
 * sends one.
 */
const BOT_USER_AGENT =
  /bot\b|bot\/|crawl|spider|slurp|scrap|headless|phantomjs|puppeteer|playwright|selenium|webdriver|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|inspectiontool|facebookexternalhit|preview|embedly|quora link|whatsapp\/|curl\/|wget|httpie|python-|aiohttp|axios|node-fetch|undici|go-http-client|java\/|okhttp|libwww|httpclient|postman|insomnia|ahrefs|semrush|mj12|dotbot|yandex|baidu|bytespider|petalbot|applebot|gptbot|claudebot|anthropic|ccbot|perplexity|amazonbot/i;

export function isBotUserAgent(userAgent: string | undefined | null): boolean {
  if (typeof userAgent !== 'string' || userAgent.trim() === '') return true;
  return BOT_USER_AGENT.test(userAgent);
}

/** `Sec-GPC: 1` or `DNT: 1` on the request itself — the server honours them too. */
export function requestOptedOut(
  header: (name: string) => string | string[] | undefined,
): boolean {
  const first = (name: string) => {
    const value = header(name);
    return (Array.isArray(value) ? value[0] : value)?.trim();
  };
  return first('sec-gpc') === '1' || first('dnt') === '1';
}

const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * A referrer reduced to a bare, lowercased hostname (`www.` dropped), or ''
 * when it is anything else: a URL with a scheme, path, query or fragment, a
 * port, credentials, an IP literal, an e-mail address, something carrying
 * a phone-number-like run of digits, or longer than 100 characters.
 */
export function normalizeReferrerDomain(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let host = raw.trim().toLowerCase();
  if (host === '' || host.length > MAX_REFERRER_DOMAIN_LENGTH) return '';
  if (/[\s/?#@:%\\]/.test(host)) return '';
  host = host.replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  if (!HOSTNAME.test(host)) return '';
  if ((host.match(/\d/g) ?? []).length >= 7) return '';
  return host;
}

/** A UTM value against the register: the registered value, `unregistered`, or '' when absent. */
export function registeredUtm(field: MktUtmField, raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') return MKT_UNREGISTERED;
  const value = raw.trim().toLowerCase();
  if (value === '') return '';
  return (MKT_UTM_REGISTER[field] as readonly string[]).includes(value)
    ? value
    : MKT_UNREGISTERED;
}

const NO_CAMPAIGN = {
  utmSource: '',
  utmMedium: '',
  utmCampaign: '',
  referrerDomain: '',
} as const;

function parseEvent(raw: unknown): MarketingEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { name, page, locale, device, props } = raw as Record<string, unknown>;
  if (!isOneOf(MKT_EVENT_NAMES, name)) return null;
  if (!isOneOf(MKT_PAGES, page)) return null;
  if (!isOneOf(MKT_LOCALES, locale)) return null;
  if (!isOneOf(MKT_DEVICES, device)) return null;
  const properties =
    props && typeof props === 'object' && !Array.isArray(props)
      ? (props as Record<string, unknown>)
      : {};

  const vocabulary = MKT_EVENT_VALUES[name];
  let value = '';
  if (vocabulary) {
    if (!isOneOf(vocabulary, properties.value)) return null;
    value = properties.value;
  }
  if (name !== 'campaign_landing') {
    return { name, page, locale, device, value, ...NO_CAMPAIGN };
  }
  return {
    name,
    page,
    locale,
    device,
    value,
    utmSource: registeredUtm('utm_source', properties.utm_source),
    utmMedium: registeredUtm('utm_medium', properties.utm_medium),
    utmCampaign: registeredUtm('utm_campaign', properties.utm_campaign),
    referrerDomain: normalizeReferrerDomain(properties.referrer_domain),
  };
}

/** The valid events in a beacon body; anything malformed is dropped silently. */
export function parseMarketingBeacon(body: unknown): MarketingEvent[] {
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return [];
  const result: MarketingEvent[] = [];
  for (const raw of events.slice(0, MAX_EVENTS_PER_BEACON)) {
    const event = parseEvent(raw);
    if (event) result.push(event);
  }
  return result;
}

const keyOf = (event: MarketingEvent): string =>
  [
    event.name,
    event.page,
    event.locale,
    event.device,
    event.value,
    event.utmSource,
    event.utmMedium,
    event.utmCampaign,
    event.referrerDomain,
  ].join('\u0000');

/**
 * Collapses a batch into one increment per distinct row. Events a page
 * load produces once (`MKT_ONCE_PER_BATCH`) count at most once per batch,
 * so a replayed or forged batch cannot inflate them by repetition.
 */
export function aggregateMarketingEvents(
  events: readonly MarketingEvent[],
): MarketingEventIncrement[] {
  const rows = new Map<string, MarketingEventIncrement>();
  for (const event of events) {
    const key = keyOf(event);
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, { ...event, count: 1 });
    } else if (!MKT_ONCE_PER_BATCH.has(event.name)) {
      rows.set(key, { ...existing, count: existing.count + 1 });
    }
  }
  return [...rows.values()];
}

/** The UTC calendar day a moment falls on, as a midnight-UTC Date (`@db.Date`). */
export function utcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
