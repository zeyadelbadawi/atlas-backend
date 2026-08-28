/**
 * SearchService — `GET /search?q=` (master plan §21 Phase P17, §15).
 *
 * THE SECURITY BOUNDARY (master plan §21 P17's own emphasis, repeated
 * here deliberately): every visibility decision below is made
 * server-side, from the AUTHENTICATED session's own re-verified
 * `is_platform_owner` flag and the caller's own real organization
 * memberships (`OrganizationMembershipsRepository`) — never from a
 * client-supplied role/organizationId/category filter. The frontend's own
 * `filterSearchResultsByRole` is documented there as "a defensive second
 * layer, not the enforcement point" — this service IS the enforcement
 * point.
 *
 * - `users`/`platform` categories: Platform-Owner-only, full stop (master
 *   plan §15's own table: "Users (name/email — Platform Owner scope
 *   only)... Organizations/Academies (`platform` category)"). A
 *   non-Platform-Owner's request for these categories is never even
 *   attempted — the query itself is skipped, not run-then-filtered.
 * - `content` category (Courses, published only): for a Platform Owner,
 *   one cross-tenant query under `runInUserContext` (reusing `courses`'
 *   existing `_platform_select` policy, P15). For a normal user, one
 *   query PER Organization they actually belong to
 *   (`OrganizationMembershipsRepository.findAllForUser`), each under
 *   `runInTenantContext(orgId)` — bounded by how many organizations one
 *   person belongs to (small, never proportional to platform size), never
 *   a query against another Organization's `app.current_organization_id`
 *   context.
 * - `system` category: available to everyone; `requiresPlatformOwner`
 *   entries are stripped server-side before matching, for the same
 *   caller.
 */
import { Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import { SearchRepository } from '../repositories/search.repository';
import type {
  AcademySearchRow,
  CourseSearchRow,
  OrganizationSearchRow,
} from '../repositories/search.repository';
import { SYSTEM_PAGES } from '../system-pages';
import { CATEGORY_LABEL_KEYS, MAX_RESULTS_PER_CATEGORY } from '../dto/search.contract';
import type {
  SearchResultGroupResponse,
  SearchResultItemResponse,
  SearchResultsResponse,
} from '../dto/search.contract';

@Injectable()
export class SearchService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly organizationMembershipsRepository: OrganizationMembershipsRepository,
    private readonly searchRepository: SearchRepository,
  ) {}

  async search(userId: string, query: string): Promise<SearchResultsResponse> {
    // Re-checked fresh from the database on every request — the same
    // `PlatformOwnerGuard`/`OrganizationsAccessGuard` posture (P15):
    // never trust a JWT claim or anything client-supplied for something
    // this sensitive.
    const user = await this.usersRepository.findById(userId);
    const isPlatformOwner = user?.isPlatformOwner ?? false;

    const groups: SearchResultGroupResponse[] = [];

    if (isPlatformOwner) {
      groups.push(await this.searchUsersGroup(query));
      groups.push(await this.searchPlatformGroup(userId, query));
      groups.push(await this.searchContentGroupForPlatformOwner(userId, query));
    } else {
      groups.push(await this.searchContentGroupForTenantUser(userId, query));
    }
    groups.push(this.searchSystemGroup(query, isPlatformOwner));

    const nonEmptyGroups = groups.filter((g) => g.items.length > 0);
    return {
      query,
      groups: nonEmptyGroups,
      totalCount: nonEmptyGroups.reduce((sum, g) => sum + g.items.length, 0),
    };
  }

  // --- users (Platform Owner only) --------------------------------------

  private async searchUsersGroup(query: string): Promise<SearchResultGroupResponse> {
    const rows = await this.searchRepository.searchUsers(query, MAX_RESULTS_PER_CATEGORY);
    return this.toGroup(
      'users',
      rows.map((r) => ({
        id: r.id,
        category: 'users',
        title: r.name,
        description: r.email,
        path: `/dashboard/platform/users/${r.id}`,
      })),
    );
  }

  // --- platform (Organizations + Academies, Platform Owner only) --------

  private async searchPlatformGroup(
    platformOwnerId: string,
    query: string,
  ): Promise<SearchResultGroupResponse> {
    const [orgs, academies] = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => [
        await this.searchRepository.searchOrganizations(
          tx,
          query,
          MAX_RESULTS_PER_CATEGORY,
        ),
        await this.searchRepository.searchAcademies(tx, query, MAX_RESULTS_PER_CATEGORY),
      ],
    );

    const items: SearchResultItemResponse[] = [
      ...(orgs as OrganizationSearchRow[]).map((o) => ({
        id: o.id,
        category: 'platform' as const,
        title: o.name,
        description: 'Organization',
        path: `/dashboard/platform/organizations/${o.id}`,
      })),
      ...(academies as AcademySearchRow[]).map((a) => ({
        id: a.id,
        category: 'platform' as const,
        title: a.name,
        description: 'Academy',
        path: `/dashboard/platform/academies/${a.id}`,
      })),
    ].slice(0, MAX_RESULTS_PER_CATEGORY);

    return this.toGroup('platform', items);
  }

  // --- content (Courses, published only) ---------------------------------

  private async searchContentGroupForPlatformOwner(
    platformOwnerId: string,
    query: string,
  ): Promise<SearchResultGroupResponse> {
    const rows = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) =>
        this.searchRepository.searchCourses(tx, query, MAX_RESULTS_PER_CATEGORY, null),
    );
    return this.toGroup('content', this.mapCourseRows(rows));
  }

  private async searchContentGroupForTenantUser(
    userId: string,
    query: string,
  ): Promise<SearchResultGroupResponse> {
    const memberships = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.organizationMembershipsRepository.findAllForUser(tx, userId),
    );
    const organizationIds = [...new Set(memberships.map((m) => m.organizationId))];
    if (organizationIds.length === 0) return this.toGroup('content', []);

    // One query per Organization the caller actually belongs to — bounded
    // by that person's own membership count (typically 1–3 in this
    // codebase's own seed data), never proportional to platform size.
    // See this class's own header comment for why a single cross-org
    // query isn't possible under this table's RLS design.
    const perOrgResults = await Promise.all(
      organizationIds.map((organizationId) =>
        this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
          this.searchRepository.searchCourses(
            tx,
            query,
            MAX_RESULTS_PER_CATEGORY,
            organizationId,
          ),
        ),
      ),
    );

    const merged = perOrgResults.flat().slice(0, MAX_RESULTS_PER_CATEGORY);
    return this.toGroup('content', this.mapCourseRows(merged));
  }

  private mapCourseRows(rows: CourseSearchRow[]): SearchResultItemResponse[] {
    return rows.map((c) => ({
      id: c.id,
      category: 'content' as const,
      title: c.title,
      description: 'Course',
      path: `/dashboard/courses/${c.id}`,
    }));
  }

  // --- system (everyone, role-filtered) -----------------------------------

  private searchSystemGroup(
    query: string,
    isPlatformOwner: boolean,
  ): SearchResultGroupResponse {
    const normalizedQuery = query.toLowerCase();
    const items = SYSTEM_PAGES.filter(
      (page) => isPlatformOwner || !page.requiresPlatformOwner,
    )
      .filter(
        (page) =>
          page.title.toLowerCase().includes(normalizedQuery) ||
          page.keywords.some((k) => k.includes(normalizedQuery)),
      )
      .slice(0, MAX_RESULTS_PER_CATEGORY)
      .map((page) => ({
        id: page.id,
        category: 'system' as const,
        title: page.title,
        path: page.path,
      }));

    return this.toGroup('system', items);
  }

  private toGroup(
    category: SearchResultGroupResponse['category'],
    items: SearchResultItemResponse[],
  ): SearchResultGroupResponse {
    return { category, categoryLabelKey: CATEGORY_LABEL_KEYS[category], items };
  }
}
