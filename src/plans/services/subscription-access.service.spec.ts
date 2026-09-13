/**
 * SubscriptionAccessService — the lifecycle interpretation (Phase 11).
 *
 * These tests exist because of a specific production-visible bug: a
 * brand-new Organization was given `status: 'expired'`, so the product
 * told every new customer their subscription had ended. The states below
 * are asserted individually and, crucially, asserted to be DIFFERENT from
 * one another — a test that only checked "access is blocked" would have
 * passed happily throughout the entire period the bug existed, because
 * the gating was always right and only the meaning was wrong.
 *
 * Mocked rather than run against the database: every branch here is a
 * pure function of one subscription row plus the clock, and the clock is
 * the whole point of two of them (`isTrialPeriodOver` deliberately fires
 * before the scheduled sweep has flipped the row).
 */
import { Test } from '@nestjs/testing';
import { SubscriptionAccessService } from './subscription-access.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { TenantSubscriptionsRepository } from '../repositories/tenant-subscriptions.repository';
import { PublicHostnameResolutionRepository } from '../../public-website/repositories/public-hostname-resolution.repository';

const ORG = 'org-1';

type Row = Record<string, unknown>;

function row(overrides: Row): Row {
  return {
    organizationId: ORG,
    planId: 'plan-1',
    status: 'no_plan',
    trialEndsAt: null,
    graceEndsAt: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    billingCycle: null,
    plan: { id: 'plan-1', key: 'growth', name: 'Growth' },
    ...overrides,
  };
}

describe('SubscriptionAccessService — lifecycle', () => {
  let service: SubscriptionAccessService;
  let findByOrganizationId: jest.Mock;

  beforeEach(async () => {
    findByOrganizationId = jest.fn();

    const moduleRef = await Test.createTestingModule({
      providers: [
        SubscriptionAccessService,
        {
          provide: TenancyContextService,
          useValue: {
            // The real service opens a tenant context; the callback is
            // all this unit cares about.
            runInTenantContext: (_org: string, fn: (tx: unknown) => unknown) => fn({}),
          },
        },
        {
          provide: TenantSubscriptionsRepository,
          useValue: { findByOrganizationId },
        },
        {
          provide: PublicHostnameResolutionRepository,
          useValue: { resolveAcademyOrganization: jest.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get(SubscriptionAccessService);
  });

  it('reports a brand-new organization as no_plan, never as expired', async () => {
    findByOrganizationId.mockResolvedValue(row({ status: 'no_plan' }));

    const state = await service.getAccessState(ORG);

    expect(state.lifecycle).toBe('no_plan');
    expect(state.reason).toBe('no_plan');
    // THE REGRESSION GUARD. This is the exact assertion that would have
    // failed for the entire life of the bug.
    expect(state.lifecycle).not.toBe('expired');
    expect(state.hasAccess).toBe(false);
  });

  it('does NOT refuse mutations for a no_plan organization (onboarding must work)', async () => {
    findByOrganizationId.mockResolvedValue(row({ status: 'no_plan' }));
    await expect(service.assertHasAccess(ORG)).resolves.toBeUndefined();
  });

  it('keeps a no_plan tenant’s public websites being served', async () => {
    findByOrganizationId.mockResolvedValue(row({ status: 'no_plan' }));
    await expect(service.isServingEligible(ORG)).resolves.toBe(true);
  });

  it('distinguishes an ended trial from a lapsed paid subscription', async () => {
    findByOrganizationId.mockResolvedValue(row({ status: 'trial_expired' }));
    const trial = await service.getAccessState(ORG);

    findByOrganizationId.mockResolvedValue(
      row({ status: 'expired', currentPeriodEnd: new Date('2026-01-01') }),
    );
    const paid = await service.getAccessState(ORG);

    expect(trial.lifecycle).toBe('trial_expired');
    expect(paid.lifecycle).toBe('expired');
    expect(trial.lifecycle).not.toBe(paid.lifecycle);
    // Both genuinely block — the split changed meaning, not enforcement.
    expect(trial.hasAccess).toBe(false);
    expect(paid.hasAccess).toBe(false);
  });

  it('refuses mutations once a trial has ended', async () => {
    findByOrganizationId.mockResolvedValue(row({ status: 'trial_expired' }));
    await expect(service.assertHasAccess(ORG)).rejects.toThrow();
  });

  it('treats a still-running trial as active access, with days remaining', async () => {
    const endsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    findByOrganizationId.mockResolvedValue(
      row({ status: 'trialing', trialEndsAt: endsAt }),
    );

    const state = await service.getAccessState(ORG);

    expect(state.lifecycle).toBe('trialing');
    expect(state.hasAccess).toBe(true);
    expect(state.trialDaysRemaining).toBe(2);
  });

  it('treats an elapsed trial clock as ended even before the sweep flips the row', async () => {
    // Still `trialing` in the database — the scheduled sweep has not run.
    findByOrganizationId.mockResolvedValue(
      row({ status: 'trialing', trialEndsAt: new Date(Date.now() - 1000) }),
    );

    const state = await service.getAccessState(ORG);

    expect(state.lifecycle).toBe('trial_expired');
    expect(state.hasAccess).toBe(false);
  });

  it('never reports a negative day count', async () => {
    findByOrganizationId.mockResolvedValue(
      row({ status: 'trialing', trialEndsAt: new Date(Date.now() + 1000) }),
    );
    const state = await service.getAccessState(ORG);
    expect(state.trialDaysRemaining).toBeGreaterThanOrEqual(0);
  });

  it('treats a cancelled-but-still-paid subscription as working, not expired', async () => {
    findByOrganizationId.mockResolvedValue(
      row({
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      }),
    );

    const state = await service.getAccessState(ORG);

    expect(state.lifecycle).toBe('cancelled_active');
    // The customer paid for this time and keeps it.
    expect(state.hasAccess).toBe(true);
    expect(state.lifecycle).not.toBe('expired');
  });

  it('reports a healthy paid subscription as active', async () => {
    findByOrganizationId.mockResolvedValue(row({ status: 'active' }));
    const state = await service.getAccessState(ORG);
    expect(state.lifecycle).toBe('active');
    expect(state.hasAccess).toBe(true);
  });

  it('keeps grace_period and past_due working', async () => {
    for (const status of ['grace_period', 'past_due']) {
      findByOrganizationId.mockResolvedValue(row({ status }));
      const state = await service.getAccessState(ORG);
      expect(state.hasAccess).toBe(true);
    }
  });
});
