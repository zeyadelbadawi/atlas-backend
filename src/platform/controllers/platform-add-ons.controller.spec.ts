/**
 * The Add-ons Management controller is a thin, authenticated delegation to
 * its service — but two things about it are load-bearing and pinned here:
 * it is guarded by BOTH `JwtAuthGuard` (401 for anonymous) and
 * `PlatformOwnerGuard` (403 for a tenant user), and it takes the actor from
 * the authenticated context, never from request input. The cross-tenant
 * RLS behaviour is proven against real Postgres in the e2e suite.
 */
import { Test } from '@nestjs/testing';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { PlatformAddOnsController } from './platform-add-ons.controller';
import { PlatformAddOnsService } from '../services/platform-add-ons.service';

const AUTH: AuthContext = { userId: 'po-1' } as AuthContext;

describe('PlatformAddOnsController', () => {
  let controller: PlatformAddOnsController;
  let list: jest.Mock;
  let updateCatalogStatus: jest.Mock;

  beforeEach(async () => {
    list = jest.fn().mockResolvedValue({ items: [], pagination: {} });
    updateCatalogStatus = jest.fn().mockResolvedValue({ key: 'k' });

    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformAddOnsController],
      providers: [
        { provide: PlatformAddOnsService, useValue: { list, updateCatalogStatus } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      // P64 Phase 1 — management controllers also carry
      // `ManagementSurfaceGuard` (a learner principal is refused).
      .overrideGuard(ManagementSurfaceGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(PlatformOwnerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(PlatformAddOnsController);
  });

  it('is guarded by JwtAuthGuard AND PlatformOwnerGuard', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      PlatformAddOnsController,
    ) as unknown[];
    const names = guards.map((g) => (g as { name: string }).name);
    expect(names).toEqual(expect.arrayContaining(['JwtAuthGuard', 'PlatformOwnerGuard']));
  });

  it('lists using the authenticated actor and forwards the query', async () => {
    await controller.list(AUTH, { status: 'draft' } as never);
    expect(list).toHaveBeenCalledWith('po-1', { status: 'draft' });
  });

  it('changes status using the authenticated actor, the path key and the body', async () => {
    await controller.updateStatus(AUTH, 'live-sessions', {
      catalogStatus: 'published',
      expectedVersion: 2,
    });
    expect(updateCatalogStatus).toHaveBeenCalledWith('po-1', 'live-sessions', {
      catalogStatus: 'published',
      expectedVersion: 2,
    });
  });
});
