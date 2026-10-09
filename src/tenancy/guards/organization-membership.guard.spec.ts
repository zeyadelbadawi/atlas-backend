import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationMembershipGuard } from './organization-membership.guard';
import { OrganizationPermissions } from '../decorators/organization-permissions.decorator';
import type { TenancyContextService } from '../services/tenancy-context.service';
import type { OrganizationMembershipsRepository } from '../repositories/organization-memberships.repository';

/** A stand-in route handler; decorate it to declare required permissions. */
function plainHandler(): void {}

function buildContext(
  params: { id?: string },
  authContext?: { userId: string },
  handler: () => void = plainHandler,
): {
  context: ExecutionContext;
  request: { tenantContext?: unknown };
} {
  const request: { tenantContext?: unknown } = {};
  const req = {
    params,
    authContext,
    get tenantContext() {
      return request.tenantContext;
    },
    set tenantContext(value: unknown) {
      request.tenantContext = value;
    },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => class RouteClass {},
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('OrganizationMembershipGuard', () => {
  it('rejects when no membership row exists for the requested organization', async () => {
    const tenancyContextService = {
      runInTenantContext: jest.fn((_orgId: string, work: (tx: unknown) => unknown) =>
        work({}),
      ),
    } as unknown as TenancyContextService;
    const membershipsRepository = {
      findForUserInOrganization: jest.fn().mockResolvedValue(null),
    } as unknown as OrganizationMembershipsRepository;
    const guard = new OrganizationMembershipGuard(
      tenancyContextService,
      membershipsRepository,
      new Reflector(),
    );
    const { context } = buildContext({ id: 'org-2' }, { userId: 'user-a' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('rejects when authContext is missing (guard ordering defense)', async () => {
    const tenancyContextService = {
      runInTenantContext: jest.fn(),
    } as unknown as TenancyContextService;
    const membershipsRepository = {} as OrganizationMembershipsRepository;
    const guard = new OrganizationMembershipGuard(
      tenancyContextService,
      membershipsRepository,
      new Reflector(),
    );
    const { context } = buildContext({ id: 'org-1' }, undefined);

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    expect(tenancyContextService.runInTenantContext).not.toHaveBeenCalled();
  });

  it('attaches tenantContext and allows the request through when a membership exists', async () => {
    const tenancyContextService = {
      runInTenantContext: jest.fn((_orgId: string, work: (tx: unknown) => unknown) =>
        work({}),
      ),
    } as unknown as TenancyContextService;
    const membershipsRepository = {
      findForUserInOrganization: jest.fn().mockResolvedValue({
        id: 'membership-1',
        role: 'owner',
        permissions: ['org.manage'],
      }),
    } as unknown as OrganizationMembershipsRepository;
    const guard = new OrganizationMembershipGuard(
      tenancyContextService,
      membershipsRepository,
      new Reflector(),
    );
    const { context, request } = buildContext({ id: 'org-1' }, { userId: 'user-a' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.tenantContext).toEqual({
      organizationId: 'org-1',
      membershipId: 'membership-1',
      role: 'owner',
      permissions: ['org.manage'],
    });
  });
  describe('@OrganizationPermissions', () => {
    class BillingRoutes {
      @OrganizationPermissions('tenant.payment.view')
      ownerOnly(): void {}
    }
    const ownerOnlyHandler = BillingRoutes.prototype.ownerOnly;

    function guardFor(permissions: readonly string[]) {
      const tenancyContextService = {
        runInTenantContext: jest.fn((_orgId: string, work: (tx: unknown) => unknown) =>
          work({}),
        ),
      } as unknown as TenancyContextService;
      const membershipsRepository = {
        findForUserInOrganization: jest.fn().mockResolvedValue({
          id: 'membership-1',
          role: 'manager',
          permissions,
        }),
      } as unknown as OrganizationMembershipsRepository;
      return new OrganizationMembershipGuard(
        tenancyContextService,
        membershipsRepository,
        new Reflector(),
      );
    }

    it('refuses a real member whose membership lacks the declared permission', async () => {
      const { context, request } = buildContext(
        { id: 'org-1' },
        { userId: 'manager-a' },
        ownerOnlyHandler,
      );
      await expect(guardFor(['academy.view']).canActivate(context)).rejects.toThrow(
        ForbiddenException,
      );
      expect(request.tenantContext).toBeUndefined();
    });

    it('admits a member holding the declared permission', async () => {
      const { context } = buildContext(
        { id: 'org-1' },
        { userId: 'owner-a' },
        ownerOnlyHandler,
      );
      await expect(
        guardFor(['academy.view', 'tenant.payment.view']).canActivate(context),
      ).resolves.toBe(true);
    });

    it('requires nothing beyond membership on an undecorated route', async () => {
      const { context } = buildContext({ id: 'org-1' }, { userId: 'manager-a' });
      await expect(guardFor([]).canActivate(context)).resolves.toBe(true);
    });
  });
});
