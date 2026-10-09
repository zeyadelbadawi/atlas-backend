/**
 * A5 — every management MUTATION is reachable by the subscription check.
 *
 * `SubscriptionAccessInterceptor` can only refuse an expired tenant when it
 * can tell which tenant a request belongs to: a guard-verified context
 * (`AcademyScopeGuard`, `OrganizationMembershipGuard`,
 * `AcademyOrganizationScopeGuard`), an `:academyId` parameter, or an
 * explicit `@SubscriptionScope`. A management mutation with none of those
 * was silently never checked — that is how course quizzes, assignments,
 * course announcements, grading, moderation and the blog escaped it.
 * A new such route now fails here until it declares its scope, opts out
 * with `@AllowInactiveSubscription`, or is listed below with a reason.
 */
import 'reflect-metadata';
import { collectDeclaredRoutes } from '../../common/testing/route-inventory.fixture-spec';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { ManagementSessionGuard } from '../../identity/guards/management-session.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { AcademyOrganizationScopeGuard } from '../../academy/guards/academy-organization-scope.guard';
import { ALLOW_INACTIVE_SUBSCRIPTION_KEY } from '../decorators/allow-inactive-subscription.decorator';
import {
  SUBSCRIPTION_SCOPE_KEY,
  type SubscriptionScopeSpec,
} from '../decorators/subscription-scope.decorator';

/** Management mutations that are deliberately NOT tenant-subscription work. */
const NOT_TENANT_SUBSCRIPTION_WORK: Readonly<Record<string, string>> = {
  'POST organizations': 'creates the tenant; there is no subscription to consult yet',
  'POST live-sessions/oauth/callback':
    'completes a provider connection whose start (academies/:id/live-sessions/connection/authorize) is already tenant-checked',
  'POST support-cases/mine/:caseId/messages':
    'support must keep working for an expired tenant (same rule as the support-case create routes)',
  'POST users/me/delete': "the caller's own account, never a tenant's",
  'POST users/me/delete/request': "the caller's own account, never a tenant's",
};

const TENANT_CONTEXT_GUARDS = new Set<unknown>([
  AcademyScopeGuard,
  OrganizationMembershipGuard,
  AcademyOrganizationScopeGuard,
]);

function meta<T>(
  key: string,
  route: { handler: object; controller: object },
): T | undefined {
  return (Reflect.getMetadata(key, route.handler) ??
    Reflect.getMetadata(key, route.controller)) as T | undefined;
}

describe('A5 — subscription enforcement reaches every management mutation', () => {
  const routes = collectDeclaredRoutes();
  const mutations = routes.filter(
    (r) =>
      !['GET', 'HEAD', 'OPTIONS'].includes(r.method) &&
      r.guards.some(
        (g) => g === ManagementSurfaceGuard || g === ManagementSessionGuard,
      ) &&
      !r.guards.some((g) => g === PlatformOwnerGuard),
  );

  it('found the management mutations', () => {
    expect(mutations.length).toBeGreaterThan(100);
  });

  it('every one has a tenant the interceptor can resolve, or a stated reason not to', () => {
    const unresolved = mutations
      .filter(
        (r) =>
          !r.guards.some((g) => TENANT_CONTEXT_GUARDS.has(g)) &&
          !r.path.split('/').includes(':academyId') &&
          !meta<boolean>(ALLOW_INACTIVE_SUBSCRIPTION_KEY, r) &&
          !meta<SubscriptionScopeSpec>(SUBSCRIPTION_SCOPE_KEY, r) &&
          !(r.key in NOT_TENANT_SUBSCRIPTION_WORK),
      )
      .map((r) => `${r.key}  (${r.file})`);
    expect(unresolved).toEqual([]);
  });

  it('every @SubscriptionScope names a parameter its route actually has', () => {
    const broken = mutations
      .map((r) => ({ r, scope: meta<SubscriptionScopeSpec>(SUBSCRIPTION_SCOPE_KEY, r) }))
      .filter(
        ({ r, scope }) =>
          scope && 'param' in scope && !r.path.split('/').includes(`:${scope.param}`),
      )
      .map(({ r }) => r.key);
    expect(broken).toEqual([]);
  });

  it('keeps the exemption list free of stale entries', () => {
    const live = new Set(mutations.map((r) => r.key));
    expect(Object.keys(NOT_TENANT_SUBSCRIPTION_WORK).filter((k) => !live.has(k))).toEqual(
      [],
    );
  });
});
