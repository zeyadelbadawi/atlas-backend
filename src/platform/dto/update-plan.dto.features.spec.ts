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
      { field: 'features.notARealFeature', messageKey: 'validation:invalid' },
    ]);
  });

  it('requires liveSessions as a boolean', () => {
    const missing = [
      { field: 'features.liveSessions', messageKey: 'validation:invalid' },
    ];
    expect(assertValidFeatures({})).toEqual(missing);
    expect(assertValidFeatures({ cms: true })).toEqual(missing);
    expect(assertValidFeatures({ liveSessions: 'yes' })).toEqual(missing);
  });
});
