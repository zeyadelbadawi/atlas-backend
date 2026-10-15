/**
 * B0-ANL-04 (part 2) — where a signup or a marketing enquiry came from.
 *
 * The browser keeps UTM values, the referrer DOMAIN and the landing template
 * in memory only (no cookie, no browser storage before consent) and sends
 * them once, with `POST /auth/register` (organization signup) or
 * `POST /public/contact`. Nothing here is trusted:
 *
 *   - the DTO bounds the raw payload (unknown keys are refused by the global
 *     `ValidationPipe`, oversize strings are a 400);
 *   - `sanitizeAttribution` then decides what is STORED. It never fails a
 *     signup or an enquiry: a value it does not like is simply dropped.
 *     Dropped: anything that looks like personal data — an email address
 *     (`@`, `%40`) or a phone number (9+ digits, separators allowed) — a
 *     referrer that is not a bare host name, a template that is not a short
 *     slug, and control characters. Kept values are capped at
 *     `ATTRIBUTION_VALUE_MAX` characters. No UTM value and no referrer left
 *     → `null` (an untagged visit stores nothing, not even its template).
 *
 * Whether it is stored at all is `FLAG_ATTRIBUTION_CAPTURE_MODE` (off by
 * default); the callers check it.
 */
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Longest value stored for a UTM field. */
export const ATTRIBUTION_VALUE_MAX = 100;
/** The raw ceiling the DTO accepts before sanitising (anything longer is a 400). */
const RAW_MAX = 512;

export class AttributionDto {
  @IsOptional()
  @IsString()
  @MaxLength(RAW_MAX)
  readonly utmSource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(RAW_MAX)
  readonly utmMedium?: string;

  @IsOptional()
  @IsString()
  @MaxLength(RAW_MAX)
  readonly utmCampaign?: string;

  @IsOptional()
  @IsString()
  @MaxLength(RAW_MAX)
  readonly utmTerm?: string;

  @IsOptional()
  @IsString()
  @MaxLength(RAW_MAX)
  readonly utmContent?: string;

  /** The referring site's host name only — never a full URL. */
  @IsOptional()
  @IsString()
  @MaxLength(RAW_MAX)
  readonly referrerDomain?: string;

  /** Which landing page template the visitor arrived on (`home`, `pricing`). */
  @IsOptional()
  @IsString()
  @MaxLength(RAW_MAX)
  readonly landingTemplate?: string;
}

/** What is written to `organizations.signup_attribution` / `platform_contact_submissions.attribution`. */
export interface StoredAttribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  referrerDomain?: string;
  landingTemplate?: string;
}

const UTM_KEYS = [
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'utmTerm',
  'utmContent',
] as const;

const CONTROL_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;
const EMAIL_LIKE = /@|%40/i;
/** 9+ digits with optional separators: every mobile number, never an 8-digit date. */
const PHONE_LIKE = /\d(?:[\s().\-_/+]*\d){8,}/;
const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TEMPLATE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** True when a value looks like an email address or a phone number. */
export function looksLikePersonalData(value: string): boolean {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Not valid percent-encoding: test the raw value only.
  }
  return [value, decoded].some((v) => EMAIL_LIKE.test(v) || PHONE_LIKE.test(v));
}

function cleanText(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  if (text.length === 0 || looksLikePersonalData(text)) return undefined;
  return text.slice(0, ATTRIBUTION_VALUE_MAX).trim() || undefined;
}

function cleanHost(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let host = raw.trim().toLowerCase();
  if (host.includes('/') || host.includes(':')) {
    // A full URL slipped through: keep its host name only, never the path.
    try {
      host = new URL(host.includes('://') ? host : `https://${host}`).hostname;
    } catch {
      return undefined;
    }
  }
  host = host.replace(/\.$/, '');
  if (!HOST_NAME.test(host) || looksLikePersonalData(host)) return undefined;
  return host;
}

function cleanTemplate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const slug = raw.trim().toLowerCase();
  return TEMPLATE_SLUG.test(slug) ? slug : undefined;
}

/** What may be stored from a client-sent attribution object, or `null` for nothing. */
export function sanitizeAttribution(
  input: AttributionDto | null | undefined,
): StoredAttribution | null {
  if (!input || typeof input !== 'object') return null;
  const stored: StoredAttribution = {};
  for (const key of UTM_KEYS) {
    const value = cleanText(input[key]);
    if (value) stored[key] = value;
  }
  const referrerDomain = cleanHost(input.referrerDomain);
  if (referrerDomain) stored.referrerDomain = referrerDomain;
  // An untagged, direct visit stores nothing: the landing template alone
  // says where the form was, not where the visitor came from.
  if (Object.keys(stored).length === 0) return null;
  const landingTemplate = cleanTemplate(input.landingTemplate);
  if (landingTemplate) stored.landingTemplate = landingTemplate;
  return stored;
}
