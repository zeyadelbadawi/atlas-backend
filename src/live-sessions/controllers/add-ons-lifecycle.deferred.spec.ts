/**
 * "Coming Soon" enforcement at the add-on lifecycle boundary.
 *
 * A hidden Install button is not a control. These tests prove the BACKEND
 * refuses to install or enable a deferred add-on — even for a caller with
 * full billing permission calling the method directly, the way a forged or
 * mis-wired request would — while a non-deferred add-on still installs, and
 * disable/uninstall remain available so a tenant can always back out.
 */
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { AddOnsLifecycleController } from './add-ons-lifecycle.controller';
import { isAddOnDeferred } from '../constants/deferred-add-ons.constants';

const BILLING = 'tenant.subscription.view';

describe('AddOnsLifecycleController — Coming Soon enforcement', () => {
  let controller: AddOnsLifecycleController;
  let activate: jest.Mock;
  let setStatus: jest.Mock;
  let findByKey: jest.Mock;

  beforeEach(() => {
    activate = jest.fn().mockResolvedValue(undefined);
    setStatus = jest.fn().mockResolvedValue(undefined);
    findByKey = jest.fn((key: string) =>
      Promise.resolve({
        id: 'addon-' + key,
        key,
        effect: { featureKey: 'live_sessions' },
      }),
    );

    const tenancy = {
      runInTenantAndUserContext: (
        _o: string,
        _u: string,
        work: (tx: unknown) => unknown,
      ) => work({}),
    };
    const tenantAddOns = {
      activate,
      setStatus,
      findOne: jest.fn().mockResolvedValue({ id: 'row', status: 'installed' }),
    };
    const audit = { write: jest.fn().mockResolvedValue(undefined) };
    const access = {
      describe: jest
        .fn()
        .mockResolvedValue({ usable: false, reason: 'coming_soon', entitled: false }),
    };

    controller = new AddOnsLifecycleController(
      tenancy as never,
      { findByKey } as never,
      tenantAddOns as never,
      access as never,
      audit as never,
    );
  });

  const req = (permissions: readonly string[]): Request =>
    ({
      tenantContext: { permissions },
      authContext: { userId: 'user-1' },
    }) as unknown as Request;

  it('the deferred set contains live-sessions', () => {
    expect(isAddOnDeferred('live-sessions')).toBe(true);
    expect(isAddOnDeferred('some-other-addon')).toBe(false);
  });

  it('REFUSES install of the deferred Live Sessions add-on (403), even with billing permission', async () => {
    await expect(
      controller.install('org-1', 'live-sessions', req([BILLING]), {} as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(activate).not.toHaveBeenCalled();
  });

  it('REFUSES enable of the deferred add-on (403)', async () => {
    await expect(
      controller.enable('org-1', 'live-sessions', req([BILLING]), {} as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(setStatus).not.toHaveBeenCalled();
  });

  it('still installs a NON-deferred add-on normally', async () => {
    await controller.install('org-1', 'some-other-addon', req([BILLING]), {} as never);
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it('still allows disable/uninstall of the deferred add-on (a tenant can back out)', async () => {
    await controller.disable('org-1', 'live-sessions', req([BILLING]), {} as never);
    await controller.uninstall('org-1', 'live-sessions', req([BILLING]), {} as never);
    expect(setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'addon-live-sessions',
      'disabled',
    );
    expect(setStatus).toHaveBeenCalledWith(
      expect.anything(),
      'org-1',
      'addon-live-sessions',
      'uninstalled',
    );
  });

  /* The billing boundary is unchanged: a non-billing member is still refused. */
  it('still refuses a caller without billing permission', async () => {
    await expect(
      controller.install('org-1', 'some-other-addon', req([]), {} as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
