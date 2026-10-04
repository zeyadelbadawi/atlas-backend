/**
 * `GET /academies/:id/me` — the caller's standing in ONE academy (W5). The
 * dashboard's academy switch resolves this before it renders the target
 * academy: it proves access (a 403 here means "not staff of this academy
 * any more") and tells the UI which role badge and which permission-gated
 * screens to show. UX only — every route re-checks server-side.
 */
import type { Academy, AcademyMemberRole } from '@prisma/client';

export interface AcademySummaryResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: Academy['status'];
  readonly logo?: string;
  readonly language: string;
}

export interface AcademyMeResponse {
  readonly academy: AcademySummaryResponse;
  /** The caller's role IN THIS ACADEMY (`owner` for the organization owner). */
  readonly role: AcademyMemberRole;
  /** `organization_owner` when the role comes from owning the organization, otherwise `academy_membership`. */
  readonly roleSource: 'organization_owner' | 'academy_membership';
  /** The permission strings that apply while working in this academy. */
  readonly permissions: readonly string[];
}

export function toAcademySummaryResponse(academy: Academy): AcademySummaryResponse {
  return {
    id: academy.id,
    organizationId: academy.organizationId,
    name: academy.name,
    slug: academy.slug,
    status: academy.status,
    logo: academy.logoUrl ?? undefined,
    language: academy.language,
  };
}
