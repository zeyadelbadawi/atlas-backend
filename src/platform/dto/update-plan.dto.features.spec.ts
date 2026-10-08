import { assertValidFeatures } from './update-plan.dto';

/** Plan feature validation — current keys required, legacy keys tolerated (dropped on save), anything else rejected. */
describe('assertValidFeatures', () => {
  it('accepts the current feature set', () => {
    expect(assertValidFeatures({ liveSessions: false })).toEqual([]);
  });

  it('tolerates legacy keys an old plan editor still sends', () => {
    expect(
      assertValidFeatures({
        liveSessions: true,
        cms: true,
        seoAdvanced: false,
        customDomain: true,
        backup: false,
      }),
    ).toEqual([]);
  });

  it('rejects any other unknown key', () => {
    expect(assertValidFeatures({ liveSessions: false, notARealFeature: true })).toEqual([
      'features.notARealFeature is not a plan feature key',
    ]);
  });

  it('requires liveSessions as a boolean', () => {
    expect(assertValidFeatures({})).toEqual(['features.liveSessions must be a boolean']);
    expect(assertValidFeatures({ cms: true })).toEqual([
      'features.liveSessions must be a boolean',
    ]);
    expect(assertValidFeatures({ liveSessions: 'yes' })).toEqual([
      'features.liveSessions must be a boolean',
    ]);
  });
});
