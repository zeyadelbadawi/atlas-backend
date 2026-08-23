import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { OrganizationMembershipGuard } from './organization-membership.guard';
import type { TenancyContextService } from '../services/tenancy-context.service';
import type { OrganizationMembershipsRepository } from '../repositories/organization-memberships.repository';

function buildContext(
  params: { id?: string },
  authContext?: { userId: string },
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
});
