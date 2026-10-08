/**
 * `pickPlanFeatures` — the one narrowing step between a stored
 * `plans.features` JSONB value and every client or entitlement read.
 *
 * The column is not schema-enforced, so a row can hold legacy keys (written
 * before the never-enforced plan features were removed), non-boolean
 * values, or not be an object at all. None of those may surface as an
 * entitlement, and none may crash a catalog read.
 */
import {
  LEGACY_PLAN_FEATURE_KEYS,
  PLAN_FEATURE_KEYS,
  pickPlanFeatures,
} from './entitlement.types';

describe('pickPlanFeatures', () => {
  it('keeps every current key as stored', () => {
    expect(pickPlanFeatures({ liveSessions: true })).toEqual({ liveSessions: true });
    expect(pickPlanFeatures({ liveSessions: false })).toEqual({ liveSessions: false });
  });

  it('drops every legacy key, even when it was granted', () => {
    const stored = Object.fromEntries(
      LEGACY_PLAN_FEATURE_KEYS.map((key) => [key, true] as const),
    );
    expect(pickPlanFeatures({ ...stored, liveSessions: true })).toEqual({
      liveSessions: true,
    });
  });

  it('drops any other unknown key', () => {
    expect(pickPlanFeatures({ liveSessions: false, somethingElse: true })).toEqual({
      liveSessions: false,
    });
  });

  it('defaults a missing or non-boolean value to false, never to granted', () => {
    expect(pickPlanFeatures({})).toEqual({ liveSessions: false });
    expect(pickPlanFeatures({ liveSessions: 'true' })).toEqual({ liveSessions: false });
    expect(pickPlanFeatures({ liveSessions: 1 })).toEqual({ liveSessions: false });
  });

  it.each([null, undefined, 'features', 42, [true]])(
    'treats a non-object value (%p) as no features',
    (raw) => {
      expect(pickPlanFeatures(raw)).toEqual({ liveSessions: false });
    },
  );

  it('returns exactly the current keys', () => {
    expect(Object.keys(pickPlanFeatures({ cms: true }))).toEqual([...PLAN_FEATURE_KEYS]);
  });

  it('shares no key between the current and legacy lists', () => {
    const legacy = new Set<string>(LEGACY_PLAN_FEATURE_KEYS);
    expect(PLAN_FEATURE_KEYS.filter((key) => legacy.has(key))).toEqual([]);
  });
});
