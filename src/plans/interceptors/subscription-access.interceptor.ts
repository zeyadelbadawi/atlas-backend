/**
 * The one place an expired tenant is actually stopped.
 *
 * THE GAP THIS CLOSES. `EntitlementEnforcementService` has always been
 * called at specific write sites — creating a course, provisioning an
 * academy — where a plan LIMIT applies. Everything else was ungated: an
 * Organization whose trial ended last night could still edit its website,
 * publish it, upload media, author announcements and manage members,
 * because none of those consume a counted resource and so none of them
 * asked. Frontend routing would have hidden the screens, which is not a
 * control at all: the API was reachable with a token and a URL.
 *
 * WHY AN INTERCEPTOR AND NOT A GUARD. Nest runs global guards BEFORE
 * controller-level ones, so a global guard executes before
 * `AcademyScopeGuard`/`OrganizationMembershipGuard` have resolved which
 * Organization the request even belongs to — it would have to re-derive
 * the tenant itself, duplicating resolution logic that is security-
 * critical and already correct. Interceptors run AFTER all guards, so the
 * tenant context is already on the request, already verified, and this
 * only has to read it. Throwing here still short-circuits: the handler
 * never runs.
 *
 * HOW IT FINDS THE TENANT, AND WHY IT NEEDED TWO WAYS. The first version
 * read only the verified `academyContext`/`tenantContext` a guard had
 * already put on the request, on the reasoning that a route without one is
 * not a tenant mutation. That reasoning was WRONG, and the test that proved
 * it was the announcement one: `AnnouncementsController` deliberately runs
 * on `JwtAuthGuard` alone — its scoping happens inside the service and in
 * RLS, which is a legitimate design this pass is not going to relitigate —
 * so no context object ever exists, and an expired tenant could still
 * publish announcements to its entire academy. Failing open on the routes
 * that happen not to use a particular guard is not a fail-safe property; it
 * is a hole shaped like one.
 *
 * So an explicit `:academyId` route parameter is also accepted, resolved to
 * its Organization through the same narrow lookup the public runtime uses.
 * That is a read of ownership, not of authorisation: it only decides WHOSE
 * subscription to consult, and the handler's own authorisation still runs
 * untouched afterwards.
 *
 * A5 — routes that scope themselves in their services with a COURSE or a
 * BLOG POST id (course authoring, grading, course announcements, forum and
 * review moderation, the blog) declare it with `@SubscriptionScope`, and
 * that id is resolved — in the caller's own RLS context — to its academy.
 *
 * A route with none of these — sign-in, password reset, the public website
 * runtime, platform-owner tooling, a learner's own submissions/attempts —
 * is still skipped, and deliberately:
 * gating those on a tenant's subscription would be wrong, and for auth it
 * would lock a customer out of the very account they need in order to pay.
 *
 * WHY ONLY MUTATIONS. An expired tenant must still be able to READ — their
 * dashboard has to load in order to explain why it is locked, their billing
 * page has to show what lapsed, and their data must visibly still be there.
 * Blocking reads would turn "your subscription ended" into "your data is
 * gone", which is both false and the single worst message this product
 * could send.
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { SubscriptionAccessService } from '../services/subscription-access.service';
import { ALLOW_INACTIVE_SUBSCRIPTION_KEY } from '../decorators/allow-inactive-subscription.decorator';
import {
  SUBSCRIPTION_SCOPE_KEY,
  type SubscriptionScopeSpec,
} from '../decorators/subscription-scope.decorator';

/** Methods that only read. `HEAD`/`OPTIONS` included so CORS preflight is never refused for a billing reason. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class SubscriptionAccessInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly subscriptionAccessService: SubscriptionAccessService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    // Non-HTTP contexts (queue workers, scheduled jobs) have no request and
    // no caller to refuse — they are the system acting on its own behalf.
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request>();
    if (READ_METHODS.has(request.method)) return next.handle();

    const allowsInactive = this.reflector.getAllAndOverride<boolean>(
      ALLOW_INACTIVE_SUBSCRIPTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowsInactive) return next.handle();

    const organizationId =
      request.academyContext?.organizationId ?? request.tenantContext?.organizationId;

    if (organizationId) {
      await this.subscriptionAccessService.assertHasAccess(organizationId);
      return next.handle();
    }

    /*
      No guard-verified context. An explicit `:academyId` still identifies a
      tenant — see the doc comment for the announcement controller that
      proved this branch necessary.

      Only `academyId` by name, never a bare `:id`: that parameter means a
      different resource on almost every controller here, and resolving it
      as an academy would consult the wrong tenant or none at all.
    */
    const academyId = request.params?.academyId;
    if (academyId) {
      await this.subscriptionAccessService.assertHasAccessForAcademy(academyId);
      return next.handle();
    }

    /*
      A5 — no context and no `:academyId`, but the handler names how its
      tenant is found (`@SubscriptionScope`): course authoring, grading,
      course announcements, forum/review moderation and the blog. These
      used to be skipped, so an expired tenant kept doing all of them.
      `route-surface-inventory.spec` fails for any new management mutation
      that is in none of these categories.
    */
    const scope = this.reflector.getAllAndOverride<SubscriptionScopeSpec | undefined>(
      SUBSCRIPTION_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const userId = request.authContext?.userId;
    if (!scope || !userId) return next.handle();

    if (scope.kind === 'course') {
      const courseId = request.params?.[scope.param];
      if (courseId) {
        await this.subscriptionAccessService.assertHasAccessForCourse(courseId, userId);
      }
    } else if (scope.kind === 'blogPost') {
      const postId = request.params?.[scope.param];
      if (postId) {
        await this.subscriptionAccessService.assertHasAccessForBlogPost(postId, userId);
      }
    } else {
      const body = request.body as { academyId?: unknown } | undefined;
      await this.subscriptionAccessService.assertHasAccessForBlogAuthor(
        userId,
        typeof body?.academyId === 'string' ? body.academyId : undefined,
      );
    }
    return next.handle();
  }
}
