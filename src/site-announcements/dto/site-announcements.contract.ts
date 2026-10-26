/**
 * B3 — site announcement response shapes (Platform Owner, public and
 * dashboard). Matched field-for-field by the frontend's types.
 */
export type AnnouncementSurface =
  'marketing_banner' | 'marketing_popup' | 'dashboard_banner';
export type AnnouncementStatus = 'draft' | 'active' | 'archived';
export type AnnouncementTone = 'info' | 'promo' | 'success' | 'warning';
export type AnnouncementPopupFrequency = 'once' | 'session' | 'always';
export type AnnouncementAudience = 'all' | 'organization_owners' | 'academy_staff';

export interface AnnouncementContent {
  readonly title: string | null;
  readonly body: string;
  readonly ctaLabel: string | null;
}

export interface SiteAnnouncementResponse {
  readonly id: string;
  readonly name: string;
  readonly surface: AnnouncementSurface;
  readonly status: AnnouncementStatus;
  /** True when it is showing right now (active and inside its window). */
  readonly live: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly tone: AnnouncementTone;
  readonly content: {
    readonly en: AnnouncementContent | null;
    readonly ar: AnnouncementContent | null;
  };
  readonly ctaUrl: string | null;
  readonly imageUrl: string | null;
  readonly pages: readonly string[];
  readonly dismissible: boolean;
  readonly popupDelaySeconds: number;
  readonly popupFrequency: AnnouncementPopupFrequency;
  readonly audience: AnnouncementAudience;
  readonly priority: number;
  readonly version: number;
  readonly stats: {
    readonly views: number;
    readonly clicks: number;
    readonly dismissals: number;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdByName: string | null;
  readonly updatedByName: string | null;
}

/** One announcement for a visitor, in the requested language. */
export interface PublicAnnouncement {
  readonly id: string;
  readonly surface: AnnouncementSurface;
  readonly tone: AnnouncementTone;
  readonly title: string | null;
  readonly body: string;
  readonly ctaLabel: string | null;
  readonly ctaUrl: string | null;
  readonly imageUrl: string | null;
  readonly dismissible: boolean;
  readonly popupDelaySeconds: number;
  readonly popupFrequency: AnnouncementPopupFrequency;
  readonly updatedAt: string;
}

export interface PublicMarketingAnnouncements {
  readonly banners: readonly PublicAnnouncement[];
  readonly popup: PublicAnnouncement | null;
}

export interface DashboardAnnouncements {
  readonly banners: readonly PublicAnnouncement[];
}
