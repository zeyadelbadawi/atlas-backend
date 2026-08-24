import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AcademyScopeGuard } from './academy-scope.guard';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import type { AcademiesRepository } from '../repositories/academies.repository';

function buildContext(
  params: { id?: string },
  authContext?: { userId: string },
): { context: ExecutionContext; request: { academyContext?: unknown } } {
  const request: { academyContext?: unknown } = {};
  const req = {
    params,
    authContext,
    get academyContext() {
      return request.academyContext;
    },
    set academyContext(value: unknown) {
      request.academyContext = value;
    },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('AcademyScopeGuard', () => {
  it('rejects when authContext is missing (guard ordering defense)', async () => {
    const tenancyContextService = {
      runInUserContext: jest.fn(),
      runInTenantContext: jest.fn(),
    } as unknown as TenancyContextService;
    const academiesRepository = {} as AcademiesRepository;
    const membershipsRepository = {} as OrganizationMembershipsRepository;
    const guard = new AcademyScopeGuard(
      tenancyContextService,
      academiesRepository,
      membershipsRepository,
    );
    const { context } = buildContext({ id: 'academy-1' }, undefined);

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    expect(tenancyContextService.runInUserContext).not.toHaveBeenCalled();
  });

  it('rejects when the bootstrap read finds no visible academy (nonexistent or not org-member)', async () => {
    const tenancyContextService = {
      runInUserContext: jest.fn((_userId: string, work: (tx: unknown) => unknown) =>
        work({}),
      ),
      runInTenantContext: jest.fn(),
    } as unknown as TenancyContextService;
    const academiesRepository = {
      findVisibleToUser: jest.fn().mockResolvedValue(null),
    } as unknown as AcademiesRepository;
    const membershipsRepository = {} as OrganizationMembershipsRepository;
    const guard = new AcademyScopeGuard(
      tenancyContextService,
      academiesRepository,
      membershipsRepository,
    );
    const { context } = buildContext({ id: 'academy-1' }, { userId: 'user-a' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    expect(tenancyContextService.runInTenantContext).not.toHaveBeenCalled();
  });

  it('rejects when the bootstrap read succeeds but the re-verified membership does not (defense in depth)', async () => {
    const tenancyContextService = {
      runInUserContext: jest.fn((_userId: string, work: (tx: unknown) => unknown) =>
        work({}),
      ),
      runInTenantContext: jest.fn((_orgId: string, work: (tx: unknown) => unknown) =>
        work({}),
      ),
    } as unknown as TenancyContextService;
    const academiesRepository = {
      findVisibleToUser: jest
        .fn()
        .mockResolvedValue({ id: 'academy-1', organizationId: 'org-1' }),
    } as unknown as AcademiesRepository;
    const membershipsRepository = {
      findForUserInOrganization: jest.fn().mockResolvedValue(null),
    } as unknown as OrganizationMembershipsRepository;
    const guard = new AcademyScopeGuard(
      tenancyContextService,
      academiesRepository,
      membershipsRepository,
    );
    const { context } = buildContext({ id: 'academy-1' }, { userId: 'user-a' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('attaches academyContext and allows the request through when membership is verified', async () => {
    const tenancyContextService = {
      runInUserContext: jest.fn((_userId: string, work: (tx: unknown) => unknown) =>
        work({}),
      ),
      runInTenantContext: jest.fn((_orgId: string, work: (tx: unknown) => unknown) =>
        work({}),
      ),
    } as unknown as TenancyContextService;
    const academiesRepository = {
      findVisibleToUser: jest
        .fn()
        .mockResolvedValue({ id: 'academy-1', organizationId: 'org-1' }),
    } as unknown as AcademiesRepository;
    const membershipsRepository = {
      findForUserInOrganization: jest
        .fn()
        .mockResolvedValue({ id: 'membership-1', role: 'owner' }),
    } as unknown as OrganizationMembershipsRepository;
    const guard = new AcademyScopeGuard(
      tenancyContextService,
      academiesRepository,
      membershipsRepository,
    );
    const { context, request } = buildContext({ id: 'academy-1' }, { userId: 'user-a' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.academyContext).toEqual({
      academyId: 'academy-1',
      organizationId: 'org-1',
      organizationMembershipId: 'membership-1',
      organizationRole: 'owner',
    });
  });
});
