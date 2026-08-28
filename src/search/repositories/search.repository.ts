/**
 * SearchRepository — PostgreSQL full-text search queries (master plan
 * §15/§21 Phase P17) against the `search_vector` generated columns
 * (`prisma/migrations/20260828120000_p17_notifications_search/
 * migration.sql`). `websearch_to_tsquery` (not `plainto_tsquery`) is used
 * throughout — it accepts the exact free-text a search box collects
 * (quoted phrases, `-exclude` terms) without the caller needing to
 * construct `tsquery` syntax themselves, and degrades gracefully on
 * malformed input instead of erroring.
 *
 * `users`/`organizations`/`academies` methods take no `tx` where the
 * table carries no RLS (`users`); the `platform`/`content` sources DO
 * carry RLS and must run under the caller's own
 * `TenancyContextService.runInUserContext(...)`/`runInTenantContext(...)`
 * — see `SearchService` for exactly which context each caller uses.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface UserSearchRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface OrganizationSearchRow {
  readonly id: string;
  readonly name: string;
}

export interface AcademySearchRow {
  readonly id: string;
  readonly name: string;
  readonly organization_id: string;
}

export interface CourseSearchRow {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly academy_id: string;
}

@Injectable()
export class SearchRepository {
  constructor(private readonly prisma: PrismaService) {}

  searchUsers(query: string, limit: number): Promise<UserSearchRow[]> {
    return this.prisma.$queryRaw<UserSearchRow[]>`
      SELECT "id", "name", "email" FROM "users"
      WHERE "search_vector" @@ websearch_to_tsquery('english', ${query})
      ORDER BY ts_rank("search_vector", websearch_to_tsquery('english', ${query})) DESC
      LIMIT ${limit}
    `;
  }

  searchOrganizations(
    tx: Prisma.TransactionClient,
    query: string,
    limit: number,
  ): Promise<OrganizationSearchRow[]> {
    return tx.$queryRaw<OrganizationSearchRow[]>`
      SELECT "id", "name" FROM "organizations"
      WHERE "search_vector" @@ websearch_to_tsquery('english', ${query})
      ORDER BY ts_rank("search_vector", websearch_to_tsquery('english', ${query})) DESC
      LIMIT ${limit}
    `;
  }

  searchAcademies(
    tx: Prisma.TransactionClient,
    query: string,
    limit: number,
  ): Promise<AcademySearchRow[]> {
    return tx.$queryRaw<AcademySearchRow[]>`
      SELECT "id", "name", "organization_id" FROM "academies"
      WHERE "search_vector" @@ websearch_to_tsquery('english', ${query})
      ORDER BY ts_rank("search_vector", websearch_to_tsquery('english', ${query})) DESC
      LIMIT ${limit}
    `;
  }

  /**
   * Published courses only (§15's own "content search finds public-facing
   * content" scoping — see `Reports/ARCHITECTURE.md`'s P17 section).
   *
   * `organizationId`, when provided, is an EXPLICIT filter in this query
   * — not merely relied on via `runInTenantContext`'s RLS session
   * variable. This is deliberate, not redundant: `courses` also carries
   * `courses_public_discovery_select`, a pre-existing, UNCONDITIONAL P11
   * RLS policy (`status = 'published' AND visibility = 'public'`, for the
   * public website runtime) with no tenant/user scoping at all — Postgres
   * OR's every PERMISSIVE policy together, so a publicly-visible course
   * from ANY Organization would otherwise leak through this query
   * regardless of which `app.current_organization_id` is active,
   * defeating tenant isolation entirely (a real cross-tenant leak,
   * caught by this phase's own e2e test S11 before this fix). This is
   * the master plan §21 P17's own "business-level visibility checks must
   * also exist in the service/repository query path, not just the RLS
   * layer" rule, applied concretely. `organizationId` is omitted only for
   * the Platform Owner's cross-tenant path, where full breadth is
   * intentional.
   */
  searchCourses(
    tx: Prisma.TransactionClient,
    query: string,
    limit: number,
    organizationId: string | null,
  ): Promise<CourseSearchRow[]> {
    if (organizationId) {
      return tx.$queryRaw<CourseSearchRow[]>`
        SELECT c."id", c."title", c."slug", c."academy_id" FROM "courses" c
        JOIN "academies" a ON a."id" = c."academy_id"
        WHERE c."status" = 'published'
          AND a."organization_id" = ${organizationId}
          AND c."search_vector" @@ websearch_to_tsquery('english', ${query})
        ORDER BY ts_rank(c."search_vector", websearch_to_tsquery('english', ${query})) DESC
        LIMIT ${limit}
      `;
    }
    return tx.$queryRaw<CourseSearchRow[]>`
      SELECT "id", "title", "slug", "academy_id" FROM "courses"
      WHERE "status" = 'published'
        AND "search_vector" @@ websearch_to_tsquery('english', ${query})
      ORDER BY ts_rank("search_vector", websearch_to_tsquery('english', ${query})) DESC
      LIMIT ${limit}
    `;
  }
}
