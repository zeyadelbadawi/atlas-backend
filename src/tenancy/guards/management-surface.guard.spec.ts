/**
 * P64 Phase 1 — the management-surface boundary (AD-5, Finding F1) and the
 * `surface.enforce` rollout control that stages it (Phase 1 §T).
 *
 * The two are tested together on purpose: the point of the flag is that it
 * changes WHEN a learner is refused, never WHO the guard is willing to
 * refuse, and never anything about staff, platform owners or the
 * brand-new unaffiliated account.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ManagementSurfaceGuard } from './management-surface.guard';
import { SurfaceEnforcementService } from '../services/surface-enforcement.service';
import type { ConfigService } from '@nestjs/config';
import type { PrincipalResolverService } from '../services/principal-resolver.service';
import type { PrincipalKind } from '../services/principal-resolver.service';
import type { SurfaceEnforcementConfig } from '../../config/configuration';

function contextFor(userId?: string) {
  const request: Record<string, unknown> = userId
    ? { authContext: { userId }, method: 'GET', path: '/academies' }
    : {};
  return {
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
    request,
  };
}

function resolverFor(kind: PrincipalKind, academyIds: readonly string[] = []) {
  return {
    forRequest: jest.fn().mockResolvedValue({
      userId: 'user-1',
      kind,
      isPlatformOwner: kind === 'platform_owner',
      organizationMembershipCount: kind === 'staff' ? 1 : 0,
      academyStaff: [],
      academies: academyIds.map((academyId) => ({
        academyId,
        name: academyId,
        slug: academyId,
        membershipStatus: 'active',
        blocked: false,
      })),
    }),
  } as unknown as PrincipalResolverService;
}

function enforcement(config: SurfaceEnforcementConfig): SurfaceEnforcementService {
  return new SurfaceEnforcementService({
    get: () => config,
  } as unknown as ConfigService);
}

const FULLY_ON = enforcement({ mode: 'on', academyIds: [] });

describe('ManagementSurfaceGuard', () => {
  it('refuses a learner', async () => {
    const guard = new ManagementSurfaceGuard(resolverFor('learner'), FULLY_ON);
    const { context } = contextFor('user-1');
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('admits staff, platform owners and brand-new unaffiliated accounts', async () => {
    for (const kind of ['staff', 'platform_owner', 'unaffiliated'] as const) {
      const guard = new ManagementSurfaceGuard(resolverFor(kind), FULLY_ON);
      const { context } = contextFor('user-1');
      await expect(guard.canActivate(context)).resolves.toBe(true);
    }
  });

  it('refuses when no authenticated user is present (guard ordering defense)', async () => {
    const resolver = resolverFor('staff');
    const guard = new ManagementSurfaceGuard(resolver, FULLY_ON);
    const { context } = contextFor(undefined);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    expect(resolver.forRequest).not.toHaveBeenCalled();
  });

  it('carries the distinct message key the frontend routes on', async () => {
    const guard = new ManagementSurfaceGuard(resolverFor('learner'), FULLY_ON);
    const { context } = contextFor('user-1');
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { messageKey: 'errors.auth.managementSurfaceOnly' },
    });
  });

  describe('surface.enforce rollout control', () => {
    it('lets a learner through while the rollout is off, and says so in the log', async () => {
      const service = enforcement({ mode: 'off', academyIds: [] });
      const bypass = jest.spyOn(service, 'logBypass');
      const guard = new ManagementSurfaceGuard(resolverFor('learner'), service);
      const { context } = contextFor('user-1');
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(bypass).toHaveBeenCalledWith('user-1', 'GET /academies');
    });

    it('refuses a learner of a listed academy and admits a learner of an unlisted one', async () => {
      const service = enforcement({ mode: 'allowlist', academyIds: ['academy-in'] });

      const inside = new ManagementSurfaceGuard(
        resolverFor('learner', ['academy-in']),
        service,
      );
      await expect(inside.canActivate(contextFor('user-1').context)).rejects.toThrow(
        ForbiddenException,
      );

      const outside = new ManagementSurfaceGuard(
        resolverFor('learner', ['academy-out']),
        service,
      );
      await expect(outside.canActivate(contextFor('user-1').context)).resolves.toBe(true);
    });

    it('refuses a learner who belongs to a listed academy among several', async () => {
      const service = enforcement({ mode: 'allowlist', academyIds: ['academy-in'] });
      const guard = new ManagementSurfaceGuard(
        resolverFor('learner', ['academy-out', 'academy-in']),
        service,
      );
      await expect(guard.canActivate(contextFor('user-1').context)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('never changes the answer for staff, platform owners or unaffiliated accounts', async () => {
      for (const mode of ['off', 'allowlist', 'on'] as const) {
        const service = enforcement({ mode, academyIds: [] });
        for (const kind of ['staff', 'platform_owner', 'unaffiliated'] as const) {
          const guard = new ManagementSurfaceGuard(resolverFor(kind), service);
          await expect(guard.canActivate(contextFor('user-1').context)).resolves.toBe(
            true,
          );
        }
      }
    });

    it('enforces when the configuration is missing entirely', async () => {
      // An unset or unreadable flag must fail closed, never open.
      const service = new SurfaceEnforcementService({
        get: () => undefined,
      } as unknown as ConfigService);
      const guard = new ManagementSurfaceGuard(resolverFor('learner'), service);
      await expect(guard.canActivate(contextFor('user-1').context)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
