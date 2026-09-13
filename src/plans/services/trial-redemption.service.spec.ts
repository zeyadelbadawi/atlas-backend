/**
 * TrialRedemptionService — the Free Trial business rules (Phase 11).
 *
 * The rules under test are revenue rules, so each one is asserted from
 * the direction of ABUSE rather than the happy path: can a caller trial a
 * plan that is not offered as a trial, can a second organization restore
 * a spent trial, can a lapsed payer take one. The happy path is covered
 * too, but it is not what these exist for.
 *
 * `startTrial`'s own concurrency guarantee (INSERT ... ON CONFLICT DO
 * NOTHING against a UNIQUE index) is a database property and is not
 * re-proved here — it cannot be meaningfully asserted against mocks. What
 * is asserted here is that this service always CONSULTS it, and honours
 * the answer.
 */
import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { TrialRedemptionService } from './trial-redemption.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { TrialPolicyRepository } from '../repositories/trial-policy.repository';
import { PlansRepository } from '../repositories/plans.repository';
import { TenantSubscriptionsRepository } from '../repositories/tenant-subscriptions.repository';
import { TrialEligibilityService } from './trial-eligibility.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';

const ORG = 'org-1';
const USER = 'user-1';

const TRIALABLE_PLAN = {
  id: 'plan-growth',
  key: 'growth',
  name: 'Growth',
  status: 'active',
  trialEligible: true,
  trialDurationDays: null,
};

const NON_TRIALABLE_PLAN = {
  id: 'plan-enterprise',
  key: 'enterprise',
  name: 'Enterprise',
  status: 'active',
  trialEligible: false,
  trialDurationDays: null,
};

describe('TrialRedemptionService.startTrial', () => {
  let service: TrialRedemptionService;
  let findById: jest.Mock;
  let findDefaultTrialPlan: jest.Mock;
  let startTrialRow: jest.Mock;
  let claimTrial: jest.Mock;
  let findSingleton: jest.Mock;

  beforeEach(async () => {
    findById = jest.fn();
    findDefaultTrialPlan = jest.fn().mockResolvedValue(TRIALABLE_PLAN);
    startTrialRow = jest.fn().mockResolvedValue(true);
    claimTrial = jest.fn().mockResolvedValue({ granted: true });
    findSingleton = jest.fn().mockResolvedValue({ enabled: true, durationDays: 3 });

    const tx = {
      user: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: USER, email: 'someone@example.com' }),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        TrialRedemptionService,
        {
          provide: TenancyContextService,
          useValue: {
            runInTenantAndUserContext: (
              _o: string,
              _u: string,
              fn: (t: unknown) => unknown,
            ) => Promise.resolve().then(() => fn(tx)),
          },
        },
        { provide: TrialPolicyRepository, useValue: { findSingleton } },
        { provide: PlansRepository, useValue: { findById, findDefaultTrialPlan } },
        {
          provide: TenantSubscriptionsRepository,
          useValue: { startTrial: startTrialRow },
        },
        { provide: TrialEligibilityService, useValue: { claimTrial } },
        { provide: AuditLogWriterService, useValue: { write: jest.fn() } },
      ],
    }).compile();

    service = moduleRef.get(TrialRedemptionService);
  });

  it('starts a trial on a plan configured as trial-eligible', async () => {
    findById.mockResolvedValue(TRIALABLE_PLAN);

    const result = await service.startTrial(ORG, USER, TRIALABLE_PLAN.id);

    expect(result.started).toBe(true);
    // The trial is tied to the plan the customer actually chose.
    expect(startTrialRow).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      TRIALABLE_PLAN.id,
      expect.any(Date),
    );
  });

  it('REFUSES a plan that is not configured as trial-eligible', async () => {
    findById.mockResolvedValue(NON_TRIALABLE_PLAN);

    await expect(
      service.startTrial(ORG, USER, NON_TRIALABLE_PLAN.id),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Refused BEFORE anything was consumed — neither the subscription row
    // nor the account's one lifetime trial may be touched by a request
    // that was never going to be allowed.
    expect(startTrialRow).not.toHaveBeenCalled();
    expect(claimTrial).not.toHaveBeenCalled();
  });

  it('decides eligibility from catalog configuration, not the plan key', async () => {
    // Same key the product currently excludes, but configured as eligible:
    // the answer must follow the COLUMN, proving no plan-name check exists.
    findById.mockResolvedValue({ ...NON_TRIALABLE_PLAN, trialEligible: true });

    const result = await service.startTrial(ORG, USER, NON_TRIALABLE_PLAN.id);

    expect(result.started).toBe(true);
  });

  it('honours a per-plan trial duration over the platform default', async () => {
    findById.mockResolvedValue({ ...TRIALABLE_PLAN, trialDurationDays: 14 });

    await service.startTrial(ORG, USER, TRIALABLE_PLAN.id);

    const endsAt = startTrialRow.mock.calls[0][3] as Date;
    const days = Math.round((endsAt.getTime() - Date.now()) / 86_400_000);
    expect(days).toBe(14);
  });

  it('falls back to the platform default duration when the plan sets none', async () => {
    findById.mockResolvedValue(TRIALABLE_PLAN);

    await service.startTrial(ORG, USER, TRIALABLE_PLAN.id);

    const endsAt = startTrialRow.mock.calls[0][3] as Date;
    const days = Math.round((endsAt.getTime() - Date.now()) / 86_400_000);
    expect(days).toBe(3);
  });

  it('refuses when the account has already redeemed its one trial', async () => {
    findById.mockResolvedValue(TRIALABLE_PLAN);
    claimTrial.mockResolvedValue({ granted: false, reason: 'already_redeemed' });

    const result = await service.startTrial(ORG, USER, TRIALABLE_PLAN.id);

    // An ordinary business outcome, not an error — and emphatically not a
    // started trial.
    expect(result.started).toBe(false);
    expect(result.reason).toBe('already_redeemed');
  });

  it('refuses when this organization already has a subscription or trial', async () => {
    findById.mockResolvedValue(TRIALABLE_PLAN);
    // The conditional UPDATE matched no row: not in `no_plan`.
    startTrialRow.mockResolvedValue(false);

    const result = await service.startTrial(ORG, USER, TRIALABLE_PLAN.id);

    expect(result.started).toBe(false);
    expect(result.reason).toBe('already_has_subscription');
    // The account's lifetime trial must not be spent on a request that
    // could not have succeeded anyway.
    expect(claimTrial).not.toHaveBeenCalled();
  });

  it('refuses an archived plan even when it is marked trial-eligible', async () => {
    findById.mockResolvedValue({
      ...TRIALABLE_PLAN,
      status: 'archived',
      trialEligible: true,
    });

    await expect(service.startTrial(ORG, USER, TRIALABLE_PLAN.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses everything while trials are disabled platform-wide', async () => {
    findSingleton.mockResolvedValue({ enabled: false, durationDays: 3 });

    await expect(service.startTrial(ORG, USER, TRIALABLE_PLAN.id)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(claimTrial).not.toHaveBeenCalled();
  });
});
