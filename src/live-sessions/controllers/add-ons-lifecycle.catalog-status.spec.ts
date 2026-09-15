/**
 * The catalog publication state is enforced at the install/enable boundary,
 * not just in the UI.
 *
 * A "Coming Soon" or "Draft" add-on hides its Install button in the store —
 * but a hidden button is not a security control. This file calls the
 * controller the way a curl would and proves the backend refuses to install
 * or enable anything whose authoritative `catalog_status` is not
 * `published`, while still letting an existing tenant disable/uninstall it.
 *
 * The catalog READ excludes drafts and annotates coming-soon; that is
 * covered where the catalog handler lives. Here the concern is the write.
 */
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { ForbiddenException } from '@nestjs/common';
import { AddOnsLifecycleController } from './add-ons-lifecycle.controller';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AddOnsRepository } from '../../plans/repositories/add-ons.repository';
import { TenantAddOnsRepository } from '../../plans/repositories/tenant-add-ons.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { AddOnAccessService } from '../services/add-on-access.service';

const ORG_ID = 'org-1';
const USER_ID = 'user-1';
const BILLING = 'tenant.subscription.view';

describe('AddOnsLifecycleController — catalog status enforcement', () => {
  let controller: AddOnsLifecycleController;
  let findByKey: jest.Mock;
  let activate: jest.Mock;
  let runInTenantAndUserContext: jest.Mock;

  const makeAddOn = (catalogStatus: string) => ({
    id: 'addon-1',
    key: 'demo-addon',
    name: 'Demo',
    effect: { type: 'feature', featureKey: 'liveSessions' },
    catalogStatus,
  });

  beforeEach(async () => {
    findByKey = jest.fn();
    activate = jest.fn().mockResolvedValue(undefined);
    runInTenantAndUserContext = jest.fn(async (_o, _u, work) => work({} as never));

    const moduleRef = await Test.createTestingModule({
      controllers: [AddOnsLifecycleController],
      providers: [
        { provide: TenancyContextService, useValue: { runInTenantAndUserContext } },
        { provide: AddOnsRepository, useValue: { findByKey, findAll: jest.fn() } },
        {
          provide: TenantAddOnsRepository,
          useValue: {
            activate,
            findOne: jest.fn(),
            setStatus: jest.fn(),
            findAllForOrganization: jest.fn(),
          },
        },
        { provide: AuditLogWriterService, useValue: { write: jest.fn() } },
        { provide: AddOnAccessService, useValue: { describe: jest.fn() } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(OrganizationMembershipGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(AddOnsLifecycleController);
  });

  const request = (): Request =>
    ({
      tenantContext: { permissions: [BILLING] },
      authContext: { userId: USER_ID },
    }) as unknown as Request;

  it('REFUSES install of a coming_soon add-on', async () => {
    findByKey.mockResolvedValue(makeAddOn('coming_soon'));
    await expect(
      controller.install(ORG_ID, 'demo-addon', request(), { confirm: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(activate).not.toHaveBeenCalled();
  });

  it('REFUSES enable of a coming_soon add-on', async () => {
    findByKey.mockResolvedValue(makeAddOn('coming_soon'));
    await expect(
      controller.enable(ORG_ID, 'demo-addon', request(), { confirm: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('REFUSES install of a draft add-on', async () => {
    findByKey.mockResolvedValue(makeAddOn('draft'));
    await expect(
      controller.install(ORG_ID, 'demo-addon', request(), { confirm: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(activate).not.toHaveBeenCalled();
  });

  it('ALLOWS install of a published add-on', async () => {
    findByKey.mockResolvedValue(makeAddOn('published'));
    await controller.install(ORG_ID, 'demo-addon', request(), { confirm: true });
    expect(activate).toHaveBeenCalledWith(expect.anything(), ORG_ID, 'addon-1');
  });

  it('still ALLOWS uninstall of a coming_soon add-on (an existing tenant can back out)', async () => {
    findByKey.mockResolvedValue(makeAddOn('coming_soon'));
    const tenantRepo = (controller as unknown as {
      tenantAddOnsRepository: { findOne: jest.Mock; setStatus: jest.Mock };
    }).tenantAddOnsRepository;
    tenantRepo.findOne.mockResolvedValue({ id: 'row-1', status: 'enabled' });
    tenantRepo.setStatus.mockResolvedValue(undefined);

    await expect(
      controller.uninstall(ORG_ID, 'demo-addon', request(), { confirm: true }),
    ).resolves.not.toThrow();
  });
});
