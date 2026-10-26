/**
 * B3 — site announcements' pure rules: when one is live, which marketing
 * page it shows on, which dashboard user it is for, what a page gets (up
 * to two banners and one pop-up) and what activation requires. No I/O, so
 * every rule is unit-tested directly (`site-announcement-rules.spec.ts`).
 */
import type { SiteAnnouncement } from '@prisma/client';
import type { Principal } from '../tenancy/services/principal-resolver.service';

export const ANNOUNCEMENT_LOCALES = ['en', 'ar'] as const;
export type AnnouncementLocale = (typeof ANNOUNCEMENT_LOCALES)[number];

export const ANNOUNCEMENT_SURFACES = [
  'marketing_banner',
  'marketing_popup',
  'dashboard_banner',
] as const;
export const ANNOUNCEMENT_STATUSES = ['draft', 'active', 'archived'] as const;
export const ANNOUNCEMENT_TONES = ['info', 'promo', 'success', 'warning'] as const;
export const ANNOUNCEMENT_POPUP_FREQUENCIES = ['once', 'session', 'always'] as const;
export const ANNOUNCEMENT_AUDIENCES = [
  'all',
  'organization_owners',
  'academy_staff',
] as const;

export const ANNOUNCEMENT_LIMITS = {
  name: { min: 1, max: 120 },
  title: { max: 120 },
  body: { min: 1, max: 600 },
  ctaLabel: { max: 40 },
  pages: { max: 20, itemMax: 120 },
  popupDelaySeconds: { min: 0, max: 60 },
  priority: { min: 0, max: 100 },
} as const;

export const MAX_MARKETING_BANNERS = 2;
export const MAX_DASHBOARD_BANNERS = 2;

/** A page path prefix without the locale: `/`, `/pricing`, `/blog/some-post`. */
export const ANNOUNCEMENT_PAGE_PATTERN = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/;

/** Academy roles that count as "academy staff" for the dashboard banner. */
export const ACADEMY_STAFF_ROLES = new Set([
  'owner',
  'administrator',
  'manager',
  'instructor',
]);

/** Markup is refused in announcement text (plain text only). */
export const HTML_TAG_PATTERN = /<\s*\/?\s*[a-z!?]/i;

export function isLive(
  row: Pick<SiteAnnouncement, 'status' | 'startsAt' | 'endsAt'>,
  now: Date,
): boolean {
  if (row.status !== 'active') return false;
  if (row.startsAt && row.startsAt.getTime() > now.getTime()) return false;
  if (row.endsAt && row.endsAt.getTime() <= now.getTime()) return false;
  return true;
}

/**
 * The visitor's path as a prefix-matchable value: no query or fragment, no
 * locale segment (`/ar/pricing` → `/pricing`), no trailing slash, lower
 * case. Anything unparseable is the home page.
 */
export function normalizeMarketingPath(raw: string | undefined): string {
  if (!raw) return '/';
  let path = raw.split(/[?#]/)[0].trim().toLowerCase();
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/{2,}/g, '/');
  path = path.replace(/^\/(?:ar|en)(?=\/|$)/, '');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

/**
 * `[]` = every marketing page. Otherwise a page matches a prefix when it
 * IS that path or sits under it (`/blog` matches `/blog/a-post`, not
 * `/blogger`). The prefix `/` means the home page only — every page is
 * what the empty list is for.
 */
export function matchesPage(pages: readonly string[], path: string): boolean {
  if (pages.length === 0) return true;
  return pages.some((prefix) => {
    if (prefix === '/') return path === '/';
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}

export function audienceAllows(
  audience: SiteAnnouncement['audience'],
  principal: Pick<Principal, 'isPlatformOwner' | 'ownsAnOrganization' | 'academyStaff'>,
): boolean {
  if (audience === 'all') return true;
  // The Platform Owner sees every dashboard banner, to check what customers see.
  if (principal.isPlatformOwner) return true;
  if (audience === 'organization_owners') return principal.ownsAnOrganization;
  return (
    principal.ownsAnOrganization ||
    principal.academyStaff.some(
      (row) => row.status === 'active' && ACADEMY_STAFF_ROLES.has(row.role),
    )
  );
}

export interface LocaleContent {
  readonly title: string | null;
  readonly body: string;
  readonly ctaLabel: string | null;
}

type ContentRow = Pick<
  SiteAnnouncement,
  'titleEn' | 'bodyEn' | 'ctaLabelEn' | 'titleAr' | 'bodyAr' | 'ctaLabelAr'
>;

/** A language is present when its body is set. */
export function contentFor(
  row: ContentRow,
  locale: AnnouncementLocale,
): LocaleContent | null {
  const body = locale === 'en' ? row.bodyEn : row.bodyAr;
  if (!body) return null;
  return {
    title: (locale === 'en' ? row.titleEn : row.titleAr) || null,
    body,
    ctaLabel: (locale === 'en' ? row.ctaLabelEn : row.ctaLabelAr) || null,
  };
}

/** Highest priority first, then the most recently edited. */
export function byPriority(
  a: Pick<SiteAnnouncement, 'priority' | 'updatedAt' | 'id'>,
  b: Pick<SiteAnnouncement, 'priority' | 'updatedAt' | 'id'>,
): number {
  return (
    b.priority - a.priority ||
    b.updatedAt.getTime() - a.updatedAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}

/**
 * What one marketing page gets: the live announcements for this page and
 * language, up to two banners and at most ONE pop-up (the highest
 * priority).
 */
export function selectForMarketingPage<
  T extends Pick<
    SiteAnnouncement,
    | 'id'
    | 'surface'
    | 'status'
    | 'startsAt'
    | 'endsAt'
    | 'pages'
    | 'priority'
    | 'updatedAt'
  > &
    ContentRow,
>(
  rows: readonly T[],
  locale: AnnouncementLocale,
  path: string,
  now: Date,
): { banners: T[]; popup: T | null } {
  const eligible = rows
    .filter(
      (row) =>
        isLive(row, now) &&
        contentFor(row, locale) !== null &&
        matchesPage(row.pages, path),
    )
    .sort(byPriority);
  return {
    banners: eligible
      .filter((row) => row.surface === 'marketing_banner')
      .slice(0, MAX_MARKETING_BANNERS),
    popup: eligible.find((row) => row.surface === 'marketing_popup') ?? null,
  };
}

export type ActivationProblem =
  'contentRequired' | 'popupTitleRequired' | 'ctaUrlRequired';

/**
 * What stops an announcement from being live: no language at all, a
 * pop-up language without a title, or a button label without a URL.
 */
export function activationProblem(
  row: ContentRow & Pick<SiteAnnouncement, 'surface' | 'ctaUrl'>,
): ActivationProblem | null {
  const contents = ANNOUNCEMENT_LOCALES.map((locale) => contentFor(row, locale)).filter(
    (content): content is LocaleContent => content !== null,
  );
  if (contents.length === 0) return 'contentRequired';
  if (row.surface === 'marketing_popup' && contents.some((content) => !content.title)) {
    return 'popupTitleRequired';
  }
  if (!row.ctaUrl && (row.ctaLabelEn || row.ctaLabelAr)) return 'ctaUrlRequired';
  return null;
}
