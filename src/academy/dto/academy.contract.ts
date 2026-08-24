/**
 * `Academy` response contract — matches the frontend `Academy` type
 * (`academy.types.ts`) field-for-field. Note the deliberate column-to-field
 * rename: DB columns `logo_url`/`favicon_url`/`website_url` map to
 * response fields `logo`/`favicon`/`website` — the frontend type uses the
 * shorter names, confirmed by direct inspection of `academy.types.ts`, not
 * assumed from the DB column naming.
 */
import type { Academy } from '@prisma/client';

export interface AcademyAddressResponse {
  readonly street?: string;
  readonly city?: string;
  readonly state?: string;
  readonly postalCode?: string;
  readonly country?: string;
}

export interface AcademyResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly logo?: string;
  readonly favicon?: string;
  readonly status: Academy['status'];
  readonly timezone: string;
  readonly language: string;
  readonly currency: string;
  readonly contactEmail?: string;
  readonly contactPhone?: string;
  readonly website?: string;
  readonly address?: AcademyAddressResponse;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toAcademyResponse(academy: Academy): AcademyResponse {
  return {
    id: academy.id,
    organizationId: academy.organizationId,
    name: academy.name,
    slug: academy.slug,
    description: academy.description ?? undefined,
    logo: academy.logoUrl ?? undefined,
    favicon: academy.faviconUrl ?? undefined,
    status: academy.status,
    timezone: academy.timezone,
    language: academy.language,
    currency: academy.currency,
    contactEmail: academy.contactEmail ?? undefined,
    contactPhone: academy.contactPhone ?? undefined,
    website: academy.websiteUrl ?? undefined,
    address: (academy.address as AcademyAddressResponse | null) ?? undefined,
    createdAt: academy.createdAt.toISOString(),
    updatedAt: academy.updatedAt.toISOString(),
  };
}
