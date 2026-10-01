import { PublicWebsiteController } from './public-website.controller';

// @nestjs/throttler 6.x metadata keys (`throttler.constants.js`; not
// re-exported from the package root), suffixed with the throttler name.
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';

describe('PublicWebsiteController — contact route throttling', () => {
  const handler = PublicWebsiteController.prototype.submitContactMessage;

  // The app registers one unnamed throttler, which @nestjs/throttler names
  // `default`; an override under any other name would silently not apply.
  it('limits submissions to 5 per 10 minutes on the `default` throttler', () => {
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler)).toBe(5);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, handler)).toBe(600_000);
  });

  it('leaves the other public routes on the global limit', () => {
    const read = PublicWebsiteController.prototype.getPublishedPages;
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, read)).toBeUndefined();
  });
});
