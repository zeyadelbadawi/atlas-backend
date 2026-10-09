/**
 * A5 — names the tenant of a MUTATION whose route carries neither a
 * guard-verified tenant context (`AcademyScopeGuard`,
 * `OrganizationMembershipGuard`, `AcademyOrganizationScopeGuard`) nor an
 * `:academyId` parameter, so `SubscriptionAccessInterceptor` can still
 * refuse it for an expired subscription.
 *
 * These routes scope themselves inside their services (course authoring,
 * grading, course announcements, forum moderation, review moderation,
 * the blog), which is a legitimate design — but the interceptor used to
 * skip them entirely, so an expired tenant could keep authoring quizzes,
 * grading, publishing course announcements and blog posts.
 *
 *   - `{ kind: 'course', param }` — the course id in that route parameter;
 *   - `{ kind: 'blogPost', param }` — the blog post id in that parameter;
 *   - `{ kind: 'blogAuthor' }` — a new blog post: the academy the caller
 *     authors for (`body.academyId`, or their single authoring academy).
 *
 * Resolution reads only what the CALLER can already see (their own user
 * RLS context), so it never consults — or reveals — the subscription of a
 * tenant the caller does not belong to; anything it cannot resolve is
 * left to the handler's own authorization, as before.
 */
import { SetMetadata } from '@nestjs/common';

export const SUBSCRIPTION_SCOPE_KEY = 'subscriptionScope';

export type SubscriptionScopeSpec =
  | { readonly kind: 'course'; readonly param: string }
  | { readonly kind: 'blogPost'; readonly param: string }
  | { readonly kind: 'blogAuthor' };

export const SubscriptionScope = (scope: SubscriptionScopeSpec) =>
  SetMetadata(SUBSCRIPTION_SCOPE_KEY, scope);
