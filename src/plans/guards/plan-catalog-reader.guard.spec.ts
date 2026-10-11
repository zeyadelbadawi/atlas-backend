import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { PlanCatalogReaderGuard } from './plan-catalog-reader.guard';

function contextFor(userId: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ authContext: { userId } }) }),
  } as unknown as ExecutionContext;
}

function guardWith(isPlatformOwner: boolean, roles: string[]) {
  const tenancy = {
    runInUserContext: jest.fn((_id: string, fn: (tx: unknown) => unknown) => fn({})),
  };
  const memberships = {
    findAllForUser: jest.fn(async () => roles.map((role) => ({ role }))),
  };
  const students = { existsForUser: jest.fn(async () => false) };
  const staff = { existsForUser: jest.fn(async () => false) };
  const users = { findById: jest.fn(async () => ({ isPlatformOwner })) };
  return new PlanCatalogReaderGuard(
    tenancy as never,
    memberships as never,
    students as never,
    staff as never,
    users as never,
  );
}

describe('PlanCatalogReaderGuard', () => {
  it('lets a Platform Owner read the catalog even with an Academy staff role', async () => {
    await expect(
      guardWith(true, ['manager']).canActivate(contextFor('u1')),
    ).resolves.toBe(true);
  });

  it('still refuses a non-owner Academy staff member', async () => {
    await expect(
      guardWith(false, ['manager']).canActivate(contextFor('u1')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('still allows an organization owner', async () => {
    await expect(guardWith(false, ['owner']).canActivate(contextFor('u1'))).resolves.toBe(
      true,
    );
  });
});
