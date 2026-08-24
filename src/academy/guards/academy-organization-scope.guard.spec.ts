import {
  ExecutionContext,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { AcademyOrganizationScopeGuard } from './academy-organization-scope.guard';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';

function buildContext(options: {
  method: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  authContext?: { userId: string };
}): { context: ExecutionContext; request: { tenantContext?: unknown } } {
  const request: { tenantContext?: unknown } = {};
  const req = {
    method: options.method,
    query: options.query ?? {},
    body: options.body ?? {},
    authContext: options.authContext,
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

describe('AcademyOrganizationScopeGuard', () => {
  it('rejects GET with no organizationId query param with 400 (not 403)', async () => {
    const tenancyContextService = {
      runInTenantContext: jest.fn(),
    } as unknown as TenancyContextService;
    const membershipsRepository = {} as OrganizationMembershipsRepository;
    const guard = new AcademyOrganizationScopeGuard(
      tenancyContextService,
      membershipsRepository,
    );
    const { context } = buildContext({
      method: 'GET',
      authContext: { userId: 'user-a' },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(BadRequestException);
    expect(tenancyContextService.runInTenantContext).not.toHaveBeenCalled();
  });

  it('rejects POST with no organizationId body field with 400', async () => {
    const tenancyContextService = {
      runInTenantContext: jest.fn(),
    } as unknown as TenancyContextService;
    const membershipsRepository = {} as OrganizationMembershipsRepository;
    const guard = new AcademyOrganizationScopeGuard(
      tenancyContextService,
      membershipsRepository,
    );
    const { context } = buildContext({
      method: 'POST',
      body: { name: 'x' },
      authContext: { userId: 'user-a' },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(BadRequestException);
  });

  it('rejects when no membership row exists for the requested organization', async () => {
    const tenancyContextService = {
      runInTenantContext: jest.fn((_orgId: string, work: (tx: unknown) => unknown) =>
        work({}),
      ),
    } as unknown as TenancyContextService;
    const membershipsRepository = {
      findForUserInOrganization: jest.fn().mockResolvedValue(null),
    } as unknown as OrganizationMembershipsRepository;
    const guard = new AcademyOrganizationScopeGuard(
      tenancyContextService,
      membershipsRepository,
    );
    const { context } = buildContext({
      method: 'GET',
      query: { organizationId: 'org-2' },
      authContext: { userId: 'user-a' },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('attaches tenantContext and allows the request through when a membership exists (POST body)', async () => {
    const tenancyContextService = {
      runInTenantContext: jest.fn((_orgId: string, work: (tx: unknown) => unknown) =>
        work({}),
      ),
    } as unknown as TenancyContextService;
    const membershipsRepository = {
      findForUserInOrganization: jest.fn().mockResolvedValue({
        id: 'membership-1',
        role: 'owner',
        permissions: [],
      }),
    } as unknown as OrganizationMembershipsRepository;
    const guard = new AcademyOrganizationScopeGuard(
      tenancyContextService,
      membershipsRepository,
    );
    const { context, request } = buildContext({
      method: 'POST',
      body: { organizationId: 'org-1', name: 'x' },
      authContext: { userId: 'user-a' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.tenantContext).toEqual({
      organizationId: 'org-1',
      membershipId: 'membership-1',
      role: 'owner',
      permissions: [],
    });
  });
});
