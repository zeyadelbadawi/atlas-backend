/**
 * `GET public/websites/:academyId/identity` response — Phase 6, the ONE
 * combined Academy Identity/Branding projection reused across the Public
 * Website, the Student LMS, and (via the authenticated dashboard's own
 * already-existing `useWebsiteConfiguration`/Academy fetch) the Dashboard.
 *
 * Deliberately NOT a new storage model — every field here already lives in
 * one of two existing, already-persisted sources: the `Academy` row
 * (`name`/`logoUrl`/`faviconUrl`/`contactEmail`/`contactPhone`/`address`)
 * or the Academy's PUBLISHED `WebsiteConfiguration.brand` JSON
 * (`primaryColor`/`secondaryColor`/`accentColor`). This endpoint is a
 * READ-COMBINING layer over both — never a second, duplicate identity
 * table. Colors are omitted (not defaulted) when no published website
 * configuration exists yet, so a consumer (`useAcademyIdentity`, atlas
 * frontend) can fall back to Atlas's own default theme tokens rather than
 * being handed an invented color.
 */
import type { AcademyAddressResponse } from '../../academy/dto/academy.contract';

export interface AcademyIdentityResponse {
  readonly academyId: string;
  readonly name: string;
  readonly logoUrl?: string;
  readonly faviconUrl?: string;
  /** HSL triplet strings (e.g. `"220 90% 56%"`) — matches `WebsiteBrandConfig.primaryColor`'s own shape (`HslColorTriplet`, atlas frontend) exactly, since these values ARE that same brand config, never reprojected. */
  readonly primaryColor?: string;
  readonly secondaryColor?: string;
  readonly accentColor?: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
  readonly address?: AcademyAddressResponse;
}
