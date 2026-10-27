/**
 * G1 — the acquisition channel vocabulary and the ONE rule that decides an
 * organization's channel (contract §1.1). Pure: no I/O, no clock, so the
 * CAC report, the capacity report and the Platform Owner organization page
 * all answer the same way for the same row.
 *
 * Order:
 *   1. the Platform Owner's manual override;
 *   2. the self-reported answer (`heard_from`), except `other`;
 *   3. `utm_source` / `utm_medium`;
 *   4. the referrer domain (the platform's own domain and its subdomains
 *      are never a referrer);
 *   5. `other` when the self-reported answer was `other`;
 *   6. `unknown`.
 */
import { cleanAttributionText } from './attribution';

export const ACQUISITION_CHANNELS = [
  'facebook',
  'instagram',
  'youtube',
  'tiktok',
  'whatsapp',
  'teacher_referral',
  'assistant_or_agency',
  'google_search',
  'google_ads',
  'meta_ads',
  'ai_assistant',
  'event',
  'email',
  'partner',
  'other',
  'unknown',
] as const;
export type AcquisitionChannelValue = (typeof ACQUISITION_CHANNELS)[number];

/** The options the signup and contact forms offer (analytics plan §6.2). */
export const SELF_REPORTED_CHANNELS = [
  'facebook',
  'youtube',
  'tiktok',
  'instagram',
  'whatsapp',
  'teacher_referral',
  'assistant_or_agency',
  'google_search',
  'ai_assistant',
  'event',
  'other',
] as const satisfies readonly AcquisitionChannelValue[];
export type SelfReportedChannel = (typeof SELF_REPORTED_CHANNELS)[number];

/** Spend may be logged against any channel except `unknown`. */
export const SPEND_CHANNELS = ACQUISITION_CHANNELS.filter(
  (channel): channel is Exclude<AcquisitionChannelValue, 'unknown'> =>
    channel !== 'unknown',
);
export type SpendChannel = Exclude<AcquisitionChannelValue, 'unknown'>;

/** Longest free-text answer kept for `other`. */
export const HEARD_FROM_OTHER_MAX = 100;

export type ChannelDecidedBy =
  'override' | 'self_reported' | 'utm' | 'referrer' | 'self_reported_other' | 'none';

export interface ChannelResolverInput {
  readonly override?: AcquisitionChannelValue | null;
  readonly heardFrom?: AcquisitionChannelValue | null;
  /** The stored, sanitised attribution object (`utmSource`, `utmMedium`, `referrerDomain`, ...). */
  readonly attribution?: {
    readonly utmSource?: unknown;
    readonly utmMedium?: unknown;
    readonly referrerDomain?: unknown;
  } | null;
  /** `PLATFORM_BASE_DOMAIN` — it and its subdomains are never a referrer. */
  readonly platformBaseDomain?: string | null;
}

export interface ResolvedChannel {
  readonly channel: AcquisitionChannelValue;
  readonly decidedBy: ChannelDecidedBy;
}

const PAID_MEDIUMS = new Set(['cpc', 'paid-social', 'paid']);
const PAID_SEARCH_SOURCES = new Set(['google', 'bing']);
const PAID_SOCIAL_SOURCES = new Set(['facebook', 'instagram', 'meta', 'fb', 'ig']);
const SOURCE_CHANNELS: Readonly<Record<string, AcquisitionChannelValue>> = {
  facebook: 'facebook',
  fb: 'facebook',
  instagram: 'instagram',
  ig: 'instagram',
  youtube: 'youtube',
  yt: 'youtube',
  tiktok: 'tiktok',
  whatsapp: 'whatsapp',
  wa: 'whatsapp',
  google: 'google_search',
  email: 'email',
  newsletter: 'email',
  chatgpt: 'ai_assistant',
  gemini: 'ai_assistant',
  perplexity: 'ai_assistant',
  claude: 'ai_assistant',
  copilot: 'ai_assistant',
};

function lower(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  return text.length > 0 ? text : null;
}

/** Step 3: `null` when there is no `utm_source` to go on. */
export function channelFromUtm(
  utmSource: unknown,
  utmMedium: unknown,
): AcquisitionChannelValue | null {
  const source = lower(utmSource);
  if (!source) return null;
  const medium = lower(utmMedium);
  if (medium && PAID_MEDIUMS.has(medium)) {
    if (PAID_SEARCH_SOURCES.has(source)) return 'google_ads';
    if (PAID_SOCIAL_SOURCES.has(source)) return 'meta_ads';
  }
  const mapped = SOURCE_CHANNELS[source];
  if (mapped) return mapped;
  if (source.startsWith('partner-')) return 'partner';
  if (source.startsWith('teacher-')) return 'teacher_referral';
  return 'other';
}

/** `host` is `domain` or one of its subdomains. */
function within(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

const AI_ASSISTANT_HOSTS = [
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'perplexity.ai',
  'claude.ai',
  'copilot.microsoft.com',
];
const REFERRER_DOMAINS: readonly (readonly [string, AcquisitionChannelValue])[] = [
  ['facebook.com', 'facebook'],
  ['fb.com', 'facebook'],
  ['instagram.com', 'instagram'],
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['tiktok.com', 'tiktok'],
  ['wa.me', 'whatsapp'],
  ['whatsapp.com', 'whatsapp'],
];

/** `google.com`, `google.com.eg`, `www.google.co.uk` — never `google.example.net`. */
function isGoogleSearchHost(host: string): boolean {
  const labels = host.split('.');
  const at = labels.lastIndexOf('google');
  if (at < 0) return false;
  const suffix = labels.slice(at + 1);
  return (
    suffix.length >= 1 &&
    suffix.length <= 2 &&
    suffix.every((label) => /^[a-z]{2,3}$/.test(label))
  );
}

function normalizeHost(value: unknown): string | null {
  const host = lower(value);
  if (!host) return null;
  return host.replace(/\.$/, '');
}

/**
 * Step 4: `null` when there is no usable referrer (none, or the platform's
 * own domain). Any other external referrer is a real one: `other` unless
 * mapped. Bing, DuckDuckGo and Yahoo are `other`, never `google_search`.
 */
export function channelFromReferrer(
  referrerDomain: unknown,
  platformBaseDomain?: string | null,
): AcquisitionChannelValue | null {
  const host = normalizeHost(referrerDomain);
  if (!host) return null;
  const base = normalizeHost(platformBaseDomain);
  if (base && within(host, base)) return null;
  if (AI_ASSISTANT_HOSTS.some((domain) => within(host, domain))) return 'ai_assistant';
  if (isGoogleSearchHost(host)) return 'google_search';
  for (const [domain, channel] of REFERRER_DOMAINS) {
    if (within(host, domain)) return channel;
  }
  return 'other';
}

export function resolveAcquisitionChannel(input: ChannelResolverInput): ResolvedChannel {
  if (input.override) return { channel: input.override, decidedBy: 'override' };
  const heardFrom = input.heardFrom ?? null;
  if (heardFrom && heardFrom !== 'other' && heardFrom !== 'unknown') {
    return { channel: heardFrom, decidedBy: 'self_reported' };
  }
  const attribution = input.attribution ?? null;
  const fromUtm = attribution
    ? channelFromUtm(attribution.utmSource, attribution.utmMedium)
    : null;
  if (fromUtm) return { channel: fromUtm, decidedBy: 'utm' };
  const fromReferrer = attribution
    ? channelFromReferrer(attribution.referrerDomain, input.platformBaseDomain)
    : null;
  if (fromReferrer) return { channel: fromReferrer, decidedBy: 'referrer' };
  if (heardFrom === 'other')
    return { channel: 'other', decidedBy: 'self_reported_other' };
  return { channel: 'unknown', decidedBy: 'none' };
}

/**
 * What is stored from a self-reported answer: the channel as given, and the
 * free text only with `other`, scrubbed with the attribution rules (control
 * characters removed, email- or phone-like text dropped, capped at 100).
 * Never throws: a value it does not like is simply dropped.
 */
export interface SelfReportedSource {
  readonly heardFrom: SelfReportedChannel;
  readonly heardFromOther: string | null;
}

export function sanitizeSelfReportedSource(
  heardFrom: SelfReportedChannel | null | undefined,
  heardFromOther: string | null | undefined,
): SelfReportedSource | null {
  if (!heardFrom || !(SELF_REPORTED_CHANNELS as readonly string[]).includes(heardFrom)) {
    return null;
  }
  const other =
    heardFrom === 'other'
      ? (cleanAttributionText(heardFromOther, HEARD_FROM_OTHER_MAX) ?? null)
      : null;
  return { heardFrom, heardFromOther: other };
}
