/**
 * EntitlementService — exhaustive unit tests, mirroring
 * `entitlement.utils.test`-shaped coverage the frontend would need (no
 * such frontend test file exists to import from, since this logic lives
 * in each codebase independently — see `EntitlementService`'s own doc
 * comment for why it's still a deliberate 1:1 port).
 *
 * `PLAN_LIMIT_KEYS`/`PLAN_FEATURE_KEYS` drive the exhaustive blocks below
 * — adding a new `PlanLimitKey`/`PlanFeatureKey` to `entitlement.types.ts`
 * without adding it to those arrays would silently narrow this suite's
 * coverage, but forgetting to add it to `entitlement.types.ts` in the
 * first place is caught by TypeScript itself (every fixture below is
 * fully typed against `PlanResourceLimits`/`PlanFeatures`, so an
 * incomplete fixture fails to compile) — matching the master plan's
 * "impossible to silently add a new key without adding coverage" goal as
 * closely as a plain Jest suite can.
 */
import { EntitlementService } from './entitlement.service';
import { PLAN_FEATURE_KEYS, PLAN_LIMIT_KEYS } from '../dto/entitlement.types';
import type {
  EntitlementAddOnInput,
  EntitlementPlanInput,
  PlanFeatureKey,
  PlanFeatures,
  PlanLimitKey,
  PlanResourceLimits,
} from '../dto/entitlement.types';

const BASE_LIMITS: PlanResourceLimits = {
  academies: 2,
  students: 50,
  instructors: 5,
  staff: 5,
  courses: 20,
  generalStorage: 10,
  videoStorage: 10,
};

const BASE_FEATURES: PlanFeatures = {
  cms: true,
  seo: true,
  seoAdvanced: false,
  marketing: false,
  marketingAdvanced: false,
  analytics: false,
  analyticsAdvanced: false,
  customDomain: false,
  themes: true,
  multipleThemes: false,
  backup: false,
};

function buildPlan(overrides: Partial<EntitlementPlanInput> = {}): EntitlementPlanInput {
  return {
    key: 'starter',
    limits: BASE_LIMITS,
    features: BASE_FEATURES,
    ...overrides,
  };
}

describe('EntitlementService', () => {
  let service: EntitlementService;

  beforeEach(() => {
    service = new EntitlementService();
  });

  describe('computeEffectiveEntitlements', () => {
    it('returns the base plan entitlements unchanged with no active add-ons', () => {
      const result = service.computeEffectiveEntitlements('org-1', buildPlan(), []);
      expect(result).toEqual({
        organizationId: 'org-1',
        limits: BASE_LIMITS,
        features: BASE_FEATURES,
      });
    });

    it('adds a limit add-on effect on top of the base limit', () => {
      const addOn: EntitlementAddOnInput = {
        effect: { type: 'limit', limitKey: 'academies', amount: 3 },
        compatiblePlanKeys: ['starter'],
      };
      const result = service.computeEffectiveEntitlements('org-1', buildPlan(), [addOn]);
      expect(result.limits.academies).toBe(5);
      // Every other limit untouched.
      expect(result.limits.students).toBe(50);
    });

    it('a limit add-on on an already-unlimited base limit leaves it unlimited', () => {
      const plan = buildPlan({ limits: { ...BASE_LIMITS, academies: 'unlimited' } });
      const addOn: EntitlementAddOnInput = {
        effect: { type: 'limit', limitKey: 'academies', amount: 3 },
        compatiblePlanKeys: ['starter'],
      };
      const result = service.computeEffectiveEntitlements('org-1', plan, [addOn]);
      expect(result.limits.academies).toBe('unlimited');
    });

    it('a feature add-on effect turns on a feature the base plan does not include', () => {
      const addOn: EntitlementAddOnInput = {
        effect: { type: 'feature', featureKey: 'customDomain' },
        compatiblePlanKeys: ['starter'],
      };
      const result = service.computeEffectiveEntitlements('org-1', buildPlan(), [addOn]);
      expect(result.features.customDomain).toBe(true);
      // Every other feature untouched.
      expect(result.features.analytics).toBe(false);
    });

    it('a feature add-on effect on an already-enabled feature is a harmless no-op', () => {
      const addOn: EntitlementAddOnInput = {
        effect: { type: 'feature', featureKey: 'cms' },
        compatiblePlanKeys: ['starter'],
      };
      const result = service.computeEffectiveEntitlements('org-1', buildPlan(), [addOn]);
      expect(result.features.cms).toBe(true);
    });

    it('combines multiple add-ons of both effect types', () => {
      const addOns: EntitlementAddOnInput[] = [
        {
          effect: { type: 'limit', limitKey: 'academies', amount: 1 },
          compatiblePlanKeys: ['starter'],
        },
        {
          effect: { type: 'limit', limitKey: 'staff', amount: 2 },
          compatiblePlanKeys: ['starter'],
        },
        {
          effect: { type: 'feature', featureKey: 'analytics' },
          compatiblePlanKeys: ['starter'],
        },
      ];
      const result = service.computeEffectiveEntitlements('org-1', buildPlan(), addOns);
      expect(result.limits.academies).toBe(3);
      expect(result.limits.staff).toBe(7);
      expect(result.features.analytics).toBe(true);
    });

    /** Exhaustive: every `PlanLimitKey` gets its own limit-add-on proof — see file header for why this list drives coverage. */
    describe.each(PLAN_LIMIT_KEYS)(
      'limit add-on for key "%s"',
      (limitKey: PlanLimitKey) => {
        it('adds the amount on top of the base limit', () => {
          const addOn: EntitlementAddOnInput = {
            effect: { type: 'limit', limitKey, amount: 4 },
            compatiblePlanKeys: ['starter'],
          };
          const result = service.computeEffectiveEntitlements('org-1', buildPlan(), [
            addOn,
          ]);
          expect(result.limits[limitKey]).toBe((BASE_LIMITS[limitKey] as number) + 4);
        });
      },
    );

    /** Exhaustive: every `PlanFeatureKey` gets its own feature-add-on proof. */
    describe.each(PLAN_FEATURE_KEYS)(
      'feature add-on for key "%s"',
      (featureKey: PlanFeatureKey) => {
        it('turns the feature on', () => {
          const plan = buildPlan({ features: { ...BASE_FEATURES, [featureKey]: false } });
          const addOn: EntitlementAddOnInput = {
            effect: { type: 'feature', featureKey },
            compatiblePlanKeys: ['starter'],
          };
          const result = service.computeEffectiveEntitlements('org-1', plan, [addOn]);
          expect(result.features[featureKey]).toBe(true);
        });
      },
    );
  });

  describe('hasFeature', () => {
    it.each(PLAN_FEATURE_KEYS)(
      'reads key "%s" directly from the entitlements',
      (featureKey) => {
        const entitlements = { features: { ...BASE_FEATURES, [featureKey]: true } };
        expect(service.hasFeature(entitlements, featureKey)).toBe(true);
      },
    );
  });

  describe('getResourceLimitStatus', () => {
    it('returns "unknown" when limit is undefined', () => {
      expect(service.getResourceLimitStatus(5, undefined)).toBe('unknown');
    });

    it('returns "unknown" when used is undefined', () => {
      expect(service.getResourceLimitStatus(undefined, 10)).toBe('unknown');
    });

    it('returns "unlimited" when limit is the literal "unlimited", regardless of used', () => {
      expect(service.getResourceLimitStatus(0, 'unlimited')).toBe('unlimited');
      expect(service.getResourceLimitStatus(999999, 'unlimited')).toBe('unlimited');
    });

    it('returns "allowed" when used is strictly below limit', () => {
      expect(service.getResourceLimitStatus(4, 5)).toBe('allowed');
    });

    it('returns "limitReached" when used equals limit (boundary)', () => {
      expect(service.getResourceLimitStatus(5, 5)).toBe('limitReached');
    });

    it('returns "limitReached" when used exceeds limit', () => {
      expect(service.getResourceLimitStatus(6, 5)).toBe('limitReached');
    });

    it('returns "allowed" when used is 0 and limit is 0... actually returns limitReached (0 >= 0)', () => {
      expect(service.getResourceLimitStatus(0, 0)).toBe('limitReached');
    });

    /** Exhaustive: every `PlanLimitKey`'s value, evaluated at below/at/above/unlimited. */
    describe.each(PLAN_LIMIT_KEYS)('for key "%s"', (limitKey: PlanLimitKey) => {
      const limit = BASE_LIMITS[limitKey] as number;

      it('below limit -> allowed', () => {
        expect(service.getResourceLimitStatus(limit - 1, limit)).toBe('allowed');
      });

      it('exactly at limit -> limitReached', () => {
        expect(service.getResourceLimitStatus(limit, limit)).toBe('limitReached');
      });

      it('above limit -> limitReached', () => {
        expect(service.getResourceLimitStatus(limit + 1, limit)).toBe('limitReached');
      });

      it('unlimited -> unlimited, regardless of used', () => {
        expect(service.getResourceLimitStatus(limit + 1000, 'unlimited')).toBe(
          'unlimited',
        );
      });
    });
  });

  describe('getLimitGapAction', () => {
    it('returns "none" when status is not limitReached', () => {
      expect(service.getLimitGapAction('academies', 'allowed', 'starter', [])).toBe(
        'none',
      );
      expect(service.getLimitGapAction('academies', 'unlimited', 'starter', [])).toBe(
        'none',
      );
      expect(service.getLimitGapAction('academies', 'unknown', 'starter', [])).toBe(
        'none',
      );
    });

    it('returns "addOn" when a compatible add-on covers the reached limit', () => {
      const catalog: EntitlementAddOnInput[] = [
        {
          effect: { type: 'limit', limitKey: 'academies', amount: 1 },
          compatiblePlanKeys: ['starter'],
        },
      ];
      expect(
        service.getLimitGapAction('academies', 'limitReached', 'starter', catalog),
      ).toBe('addOn');
    });

    it('returns "upgradePlan" when no add-on covers the reached limit', () => {
      expect(service.getLimitGapAction('academies', 'limitReached', 'starter', [])).toBe(
        'upgradePlan',
      );
    });

    it('returns "upgradePlan" when an add-on covers the limit but is not compatible with the current plan', () => {
      const catalog: EntitlementAddOnInput[] = [
        {
          effect: { type: 'limit', limitKey: 'academies', amount: 1 },
          compatiblePlanKeys: ['pro'],
        },
      ];
      expect(
        service.getLimitGapAction('academies', 'limitReached', 'starter', catalog),
      ).toBe('upgradePlan');
    });

    it('returns "upgradePlan" when an add-on is compatible but covers a different limit key', () => {
      const catalog: EntitlementAddOnInput[] = [
        {
          effect: { type: 'limit', limitKey: 'staff', amount: 1 },
          compatiblePlanKeys: ['starter'],
        },
      ];
      expect(
        service.getLimitGapAction('academies', 'limitReached', 'starter', catalog),
      ).toBe('upgradePlan');
    });

    it('returns "upgradePlan" when the only compatible add-on is a feature-type effect', () => {
      const catalog: EntitlementAddOnInput[] = [
        {
          effect: { type: 'feature', featureKey: 'cms' },
          compatiblePlanKeys: ['starter'],
        },
      ];
      expect(
        service.getLimitGapAction('academies', 'limitReached', 'starter', catalog),
      ).toBe('upgradePlan');
    });

    /** Exhaustive: every `PlanLimitKey` gets its own gap-action proof, both directions. */
    describe.each(PLAN_LIMIT_KEYS)('for key "%s"', (limitKey: PlanLimitKey) => {
      it('addOn when covered', () => {
        const catalog: EntitlementAddOnInput[] = [
          {
            effect: { type: 'limit', limitKey, amount: 1 },
            compatiblePlanKeys: ['starter'],
          },
        ];
        expect(
          service.getLimitGapAction(limitKey, 'limitReached', 'starter', catalog),
        ).toBe('addOn');
      });

      it('upgradePlan when not covered', () => {
        expect(service.getLimitGapAction(limitKey, 'limitReached', 'starter', [])).toBe(
          'upgradePlan',
        );
      });
    });
  });

  describe('getFeatureGapAction', () => {
    it('returns "none" when the feature is already available', () => {
      expect(service.getFeatureGapAction('cms', true, 'starter', [])).toBe('none');
    });

    it('returns "addOn" when a compatible add-on grants the missing feature', () => {
      const catalog: EntitlementAddOnInput[] = [
        {
          effect: { type: 'feature', featureKey: 'analytics' },
          compatiblePlanKeys: ['starter'],
        },
      ];
      expect(service.getFeatureGapAction('analytics', false, 'starter', catalog)).toBe(
        'addOn',
      );
    });

    it('returns "upgradePlan" when no add-on grants the missing feature', () => {
      expect(service.getFeatureGapAction('analytics', false, 'starter', [])).toBe(
        'upgradePlan',
      );
    });

    it('returns "upgradePlan" when a granting add-on is not compatible with the current plan', () => {
      const catalog: EntitlementAddOnInput[] = [
        {
          effect: { type: 'feature', featureKey: 'analytics' },
          compatiblePlanKeys: ['pro'],
        },
      ];
      expect(service.getFeatureGapAction('analytics', false, 'starter', catalog)).toBe(
        'upgradePlan',
      );
    });

    it('returns "upgradePlan" when the only compatible add-on is a limit-type effect', () => {
      const catalog: EntitlementAddOnInput[] = [
        {
          effect: { type: 'limit', limitKey: 'academies', amount: 1 },
          compatiblePlanKeys: ['starter'],
        },
      ];
      expect(service.getFeatureGapAction('analytics', false, 'starter', catalog)).toBe(
        'upgradePlan',
      );
    });

    /** Exhaustive: every `PlanFeatureKey` gets its own gap-action proof, both directions. */
    describe.each(PLAN_FEATURE_KEYS)('for key "%s"', (featureKey: PlanFeatureKey) => {
      it('none when already enabled', () => {
        expect(service.getFeatureGapAction(featureKey, true, 'starter', [])).toBe('none');
      });

      it('addOn when disabled but covered', () => {
        const catalog: EntitlementAddOnInput[] = [
          { effect: { type: 'feature', featureKey }, compatiblePlanKeys: ['starter'] },
        ];
        expect(service.getFeatureGapAction(featureKey, false, 'starter', catalog)).toBe(
          'addOn',
        );
      });

      it('upgradePlan when disabled and not covered', () => {
        expect(service.getFeatureGapAction(featureKey, false, 'starter', [])).toBe(
          'upgradePlan',
        );
      });
    });
  });
});
