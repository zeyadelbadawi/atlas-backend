/**
 * SearchRepository — PostgreSQL full-text search queries (master plan
 * §15/§21 Phase P17) against the `search_vector` STORED GENERATED columns
 * restored and modelled by P65
 * (`prisma/migrations/20261010000000_p65_search_vector_generated_columns/
 * migration.sql`, `schema.prisma` `searchVector Unsupported("tsvector")`).
 *
 * TWO SHAPES OF QUERY, FOR ONE REASON. PostgreSQL only lets a predicate be
 * an index condition ahead of a table's row-security policies if its
 * operator is LEAKPROOF, and `tsvector @@ tsquery` is not. On the three
 * FORCE-RLS tables (`organizations`, `academies`, `courses`) a direct
 * `WHERE search_vector @@ q` therefore degrades to a per-row Filter under
 * the policies — a sequential scan of the whole table, measured at 1.3 s
 * for 300k courses — and the GIN index is never used. `users` carries no
 * RLS, so its direct query IS served by the index.
 *
 * So the RLS-bearing sources are searched in two steps:
 *
 *   1. `search_*_candidates(...)` — SECURITY DEFINER functions from the
 *      P65 migration — re-verify the caller from the database (Platform
 *      Owner flag, or membership of the organization being searched),
 *      apply the scope explicitly, run the GIN-indexed match with no
 *      per-row policy cost, and return `(id, rank)` for at most 50 rows.
 *      An unentitled caller gets zero rows, silently, like RLS itself.
 *   2. This repository then SELECTs the visible columns FROM THE REAL
 *      TABLE by those ids, inside the caller's own
 *      `runInUserContext(...)`/`runInTenantContext(...)`, so every row
 *      returned has ALSO passed the table's RLS policies. The guard
 *      decides, RLS independently agrees, and the index is used.
 *
 * `websearch_to_tsquery` (not `plainto_tsquery`) accepts the exact free
 * text a search box collects — quoted phrases, `-excluded` terms, `or` —
 * and degrades gracefully on malformed input; a query that reduces to
 * nothing (stop words only) matches no row and yields an empty list, never
 * an error. Ranking uses the weighted vectors from the migration (name /
 * title = A, slug / short description = B, long description = C), so a
 * hit in a course's title outranks the same word buried in its
 * description; ties break on recency, then id, so a page is deterministic.
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

/**
 * The text-search configuration MUST match the one baked into the
 * generated columns and the candidate functions (`'english'` in the P65
 * migration); a query parsed under a different configuration would stem
 * differently and silently miss rows.
 */
const TS_CONFIG = 'english';

@Injectable()
export class SearchRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** `users` has no RLS: the GIN index serves this predicate directly. */
  searchUsers(query: string, limit: number): Promise<UserSearchRow[]> {
    return this.prisma.$queryRaw<UserSearchRow[]>`
      WITH q AS (SELECT websearch_to_tsquery(${TS_CONFIG}::regconfig, ${query}::text) AS tsq)
      SELECT u."id", u."name", u."email"
      FROM "users" u, q
      WHERE u."search_vector" @@ q.tsq
      ORDER BY ts_rank(u."search_vector", q.tsq) DESC, u."created_at" DESC, u."id"
      LIMIT ${limit}::integer
    `;
  }

  /** Platform Owner only — the candidate function refuses anyone else. */
  searchOrganizations(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    query: string,
    limit: number,
  ): Promise<OrganizationSearchRow[]> {
    return tx.$queryRaw<OrganizationSearchRow[]>`
      WITH cand AS (
        SELECT "id", "rank"
        FROM search_organizations_candidates(${callerUserId}::text, ${query}::text, ${limit}::integer)
      )
      SELECT o."id", o."name"
      FROM "organizations" o
      JOIN cand ON cand."id" = o."id"
      ORDER BY cand."rank" DESC, o."created_at" DESC, o."id"
    `;
  }

  /** Platform Owner only — the candidate function refuses anyone else. */
  searchAcademies(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    query: string,
    limit: number,
  ): Promise<AcademySearchRow[]> {
    return tx.$queryRaw<AcademySearchRow[]>`
      WITH cand AS (
        SELECT "id", "rank"
        FROM search_academies_candidates(${callerUserId}::text, ${query}::text, ${limit}::integer)
      )
      SELECT a."id", a."name", a."organization_id"
      FROM "academies" a
      JOIN cand ON cand."id" = a."id"
      ORDER BY cand."rank" DESC, a."created_at" DESC, a."id"
    `;
  }

  /**
   * Published courses only (§15's own "content search finds public-facing
   * content" scoping).
   *
   * `organizationId`, when provided, is an EXPLICIT scope applied inside
   * the candidate function (which also verifies the caller belongs to that
   * organization) — never merely relied on via `runInTenantContext`'s RLS
   * session variable. This is deliberate, not redundant: `courses` also
   * carries `courses_public_discovery_select`, a pre-existing,
   * UNCONDITIONAL P11 RLS policy (`status = 'published' AND visibility =
   * 'public'`, for the public website runtime) with no tenant/user scoping
   * at all — Postgres OR's every PERMISSIVE policy together, so a
   * publicly-visible course from ANY Organization would otherwise leak
   * through this query regardless of which `app.current_organization_id`
   * is active (a real cross-tenant leak, caught by e2e test S11 before it
   * was fixed). `organizationId` is `null` only for the Platform Owner's
   * cross-tenant path, where full breadth is intentional and the function
   * insists on the Platform Owner flag.
   *
   * The `status = 'published'` test is repeated on the outer read: cheap,
   * and it keeps the visible-row rule stated in the query that returns
   * the rows.
   */
  searchCourses(
    tx: Prisma.TransactionClient,
    callerUserId: string,
    organizationId: string | null,
    query: string,
    limit: number,
  ): Promise<CourseSearchRow[]> {
    return tx.$queryRaw<CourseSearchRow[]>`
      WITH cand AS (
        SELECT "id", "rank"
        FROM search_courses_candidates(
          ${callerUserId}::text, ${organizationId}::text, ${query}::text, ${limit}::integer
        )
      )
      SELECT c."id", c."title", c."slug", c."academy_id"
      FROM "courses" c
      JOIN cand ON cand."id" = c."id"
      WHERE c."status" = 'published'
      ORDER BY cand."rank" DESC, c."created_at" DESC, c."id"
    `;
  }
}
