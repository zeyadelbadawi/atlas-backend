import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { OrganizationsAccessGuard } from './organizations-access.guard';
import type { PrismaService } from '../../database/prisma.service';
import type { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';

function buildContext(
  params: { id?: string },
  authContext?: { userId: string },
): ExecutionContext {
  const req = { params, authContext };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('OrganizationsAccessGuard', () => {
  it('allows a verified Platform Owner through unconditionally, for the bare list route (no :id)', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ isPlatformOwner: true }) },
    } as unknown as PrismaService;
    const membershipGuard = {
      canActivate: jest.fn(),
    } as unknown as OrganizationMembershipGuard;
    const guard = new OrganizationsAccessGuard(prisma, membershipGuard);
    const context = buildContext({}, { userId: 'platform-owner-1' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(membershipGuard.canActivate).not.toHaveBeenCalled();
  });

  it('allows a verified Platform Owner through unconditionally, for any :id', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ isPlatformOwner: true }) },
    } as unknown as PrismaService;
    const membershipGuard = {
      canActivate: jest.fn(),
    } as unknown as OrganizationMembershipGuard;
    const guard = new OrganizationsAccessGuard(prisma, membershipGuard);
    const context = buildContext(
      { id: 'some-other-org' },
      { userId: 'platform-owner-1' },
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(membershipGuard.canActivate).not.toHaveBeenCalled();
  });

  it('refuses a non-Platform-Owner outright on the bare list route (no :id to check membership against)', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ isPlatformOwner: false }) },
    } as unknown as PrismaService;
    const membershipGuard = {
      canActivate: jest.fn(),
    } as unknown as OrganizationMembershipGuard;
    const guard = new OrganizationsAccessGuard(prisma, membershipGuard);
    const context = buildContext({}, { userId: 'tenant-user-1' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    expect(membershipGuard.canActivate).not.toHaveBeenCalled();
  });

  it('falls through to OrganizationMembershipGuard, unmodified, for a non-Platform-Owner on the :id route', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ isPlatformOwner: false }) },
    } as unknown as PrismaService;
    const membershipGuard = {
      canActivate: jest.fn().mockResolvedValue(true),
    } as unknown as OrganizationMembershipGuard;
    const guard = new OrganizationsAccessGuard(prisma, membershipGuard);
    const context = buildContext({ id: 'org-1' }, { userId: 'tenant-user-1' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(membershipGuard.canActivate).toHaveBeenCalledWith(context);
  });

  it("propagates OrganizationMembershipGuard's own refusal unchanged", async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ isPlatformOwner: false }) },
    } as unknown as PrismaService;
    const membershipGuard = {
      canActivate: jest.fn().mockRejectedValue(new ForbiddenException()),
    } as unknown as OrganizationMembershipGuard;
    const guard = new OrganizationsAccessGuard(prisma, membershipGuard);
    const context = buildContext({ id: 'org-1' }, { userId: 'tenant-user-1' });

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('rejects when authContext is missing (guard ordering defense)', async () => {
    const prisma = {
      user: { findUnique: jest.fn() },
    } as unknown as PrismaService;
    const membershipGuard = {
      canActivate: jest.fn(),
    } as unknown as OrganizationMembershipGuard;
    const guard = new OrganizationsAccessGuard(prisma, membershipGuard);
    const context = buildContext({ id: 'org-1' }, undefined);

    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('re-reads is_platform_owner from the database on every call — never trusts a cached/claimed value', async () => {
    const findUnique = jest.fn().mockResolvedValue({ isPlatformOwner: true });
    const prisma = { user: { findUnique } } as unknown as PrismaService;
    const membershipGuard = {
      canActivate: jest.fn(),
    } as unknown as OrganizationMembershipGuard;
    const guard = new OrganizationsAccessGuard(prisma, membershipGuard);

    await guard.canActivate(buildContext({}, { userId: 'user-x' }));
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'user-x' },
      select: { isPlatformOwner: true },
    });
  });
});
