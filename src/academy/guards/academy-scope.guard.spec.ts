import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AcademyScopeGuard } from './academy-scope.guard';
import {
  ACADEMY_MANAGING_ROLES,
  ACADEMY_ROLES_KEY,
} from '../decorators/academy-roles.decorator';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import type { AcademiesRepository } from '../repositories/academies.repository';
import type { AcademyMembersRepository } from '../repositories/academy-members.repository';

function buildContext(
  params: { id?: string },
  authContext?: { userId: string },
  requiredRoles?: readonly string[],
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
  const handler = () => undefined;
  if (requiredRoles) Reflect.defineMetadata(ACADEMY_ROLES_KEY, requiredRoles, handler);
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => class Anonymous {},
  } as unknown as ExecutionContext;
  return { context, request };
}

interface Fixture {
  readonly academy?: { id: string; organizationId: string } | null;
  readonly membership?: { id: string; role: string; permissions: string[] } | null;
  readonly academyMember?: { role: string; status: string } | null;
}

function buildGuard(fixture: Fixture) {
  const tenancyContextService = {
    runInUserContext: jest.fn((_userId: string, work: (tx: unknown) => unknown) =>
      work({}),
    ),
    runInTenantContext: jest.fn((_orgId: string, work: (tx: unknown) => unknown) =>
      work({}),
    ),
  } as unknown as TenancyContextService;
  const academiesRepository = {
    findVisibleToUser: jest.fn().mockResolvedValue(fixture.academy ?? null),
  } as unknown as AcademiesRepository;
  const membershipsRepository = {
    findForUserInOrganization: jest.fn().mockResolvedValue(fixture.membership ?? null),
  } as unknown as OrganizationMembershipsRepository;
  const academyMembersRepository = {
    findForUserInAcademy: jest.fn().mockResolvedValue(fixture.academyMember ?? null),
  } as unknown as AcademyMembersRepository;
  const guard = new AcademyScopeGuard(
    tenancyContextService,
    academiesRepository,
    membershipsRepository,
    academyMembersRepository,
    new Reflector(),
  );
  return { guard, tenancyContextService };
}

const ACADEMY = { id: 'academy-1', organizationId: 'org-1' };

describe('AcademyScopeGuard', () => {
  it('rejects when authContext is missing (guard ordering defense)', async () => {
    const { guard, tenancyContextService } = buildGuard({});
    const { context } = buildContext({ id: 'academy-1' }, undefined);

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    expect(tenancyContextService.runInUserContext).not.toHaveBeenCalled();
  });

  it('rejects when the bootstrap read finds no visible academy (nonexistent or not org-member)', async () => {
    const { guard, tenancyContextService } = buildGuard({ academy: null });
    const { context } = buildContext({ id: 'academy-1' }, { userId: 'user-a' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    expect(tenancyContextService.runInTenantContext).not.toHaveBeenCalled();
  });

  it('rejects when the bootstrap read succeeds but neither membership re-verifies (defense in depth)', async () => {
    const { guard } = buildGuard({ academy: ACADEMY });
    const { context } = buildContext({ id: 'academy-1' }, { userId: 'user-a' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('the organization owner is the implicit owner of every academy, without an academy_members row', async () => {
    const { guard } = buildGuard({
      academy: ACADEMY,
      membership: {
        id: 'membership-1',
        role: 'owner',
        permissions: ['tenant.dashboard.view'],
      },
    });
    const { context, request } = buildContext({ id: 'academy-1' }, { userId: 'user-a' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.academyContext).toEqual({
      academyId: 'academy-1',
      organizationId: 'org-1',
      organizationMembershipId: 'membership-1',
      organizationRole: 'owner',
      organizationPermissions: ['tenant.dashboard.view'],
      academyRole: 'owner',
      academyRoleSource: 'organization_owner',
    });
  });

  it('F12: an organization manager who is NOT staff of this academy is refused', async () => {
    const { guard } = buildGuard({
      academy: ACADEMY,
      membership: { id: 'membership-2', role: 'manager', permissions: ['course.view'] },
      academyMember: null,
    });
    const { context } = buildContext({ id: 'academy-1' }, { userId: 'user-b' });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { messageKey: 'errors.tenancy.notAMember' },
    });
  });

  it('an INACTIVE academy membership is refused even with an organization membership', async () => {
    const { guard } = buildGuard({
      academy: ACADEMY,
      membership: { id: 'membership-2', role: 'manager', permissions: [] },
      academyMember: { role: 'manager', status: 'inactive' },
    });
    const { context } = buildContext({ id: 'academy-1' }, { userId: 'user-b' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('an active academy manager resolves to their academy role', async () => {
    const { guard } = buildGuard({
      academy: ACADEMY,
      membership: { id: 'membership-2', role: 'manager', permissions: ['course.view'] },
      academyMember: { role: 'manager', status: 'active' },
    });
    const { context, request } = buildContext({ id: 'academy-1' }, { userId: 'user-b' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.academyContext).toMatchObject({
      organizationRole: 'manager',
      academyRole: 'manager',
      academyRoleSource: 'academy_membership',
    });
  });

  it('an active academy-only member (no organization membership) is scoped to this academy', async () => {
    const { guard } = buildGuard({
      academy: ACADEMY,
      membership: null,
      academyMember: { role: 'instructor', status: 'active' },
    });
    const { context, request } = buildContext({ id: 'academy-1' }, { userId: 'user-c' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.academyContext).toMatchObject({
      organizationMembershipId: '',
      organizationRole: 'academy_instructor',
      organizationPermissions: [],
      academyRole: 'instructor',
    });
  });

  it('@AcademyRoles refuses a role outside the declared tier', async () => {
    const { guard } = buildGuard({
      academy: ACADEMY,
      membership: { id: 'membership-3', role: 'instructor', permissions: [] },
      academyMember: { role: 'instructor', status: 'active' },
    });
    const { context, request } = buildContext(
      { id: 'academy-1' },
      { userId: 'user-c' },
      ACADEMY_MANAGING_ROLES,
    );

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { messageKey: 'errors.academy.insufficientRole' },
    });
    expect(request.academyContext).toBeUndefined();
  });

  it('@AcademyRoles admits the organization owner and in-tier staff', async () => {
    const owner = buildGuard({
      academy: ACADEMY,
      membership: { id: 'membership-1', role: 'owner', permissions: [] },
    });
    await expect(
      owner.guard.canActivate(
        buildContext({ id: 'academy-1' }, { userId: 'user-a' }, ACADEMY_MANAGING_ROLES)
          .context,
      ),
    ).resolves.toBe(true);

    const administrator = buildGuard({
      academy: ACADEMY,
      membership: null,
      academyMember: { role: 'administrator', status: 'active' },
    });
    await expect(
      administrator.guard.canActivate(
        buildContext({ id: 'academy-1' }, { userId: 'user-d' }, ACADEMY_MANAGING_ROLES)
          .context,
      ),
    ).resolves.toBe(true);
  });
});
