/**
 * P64 Phase 2 — two ACCEPTANCE CRITERIA that are properties of the source
 * tree rather than of a request (master plan Phase 2 §V):
 *
 *   - "`premium` is nowhere hard-wired to a provider class in the
 *     authorization layer (D10)";
 *   - "no provider price in the codebase" (D5, §D.5).
 *
 * WHY A SOURCE SCAN AND NOT A BEHAVIOURAL TEST. Both claims are about
 * what the code may NOT contain. No request can demonstrate the absence
 * of a hard-wiring — the very bug would be invisible until the day a
 * second provider was introduced, which is precisely the day it is most
 * expensive to find. A structural assertion fails the moment somebody
 * reaches for the wrong thing, in the same review cycle that introduced
 * it.
 *
 * The scan deliberately strips comments first. The authorization layer
 * NAMES Cloudflare repeatedly in prose — finding D-5 is entirely about
 * Cloudflare's behaviour and explaining it is the honest thing to do —
 * and a scan that could not tell an explanation from a dependency would
 * either fail on documentation or have to be weakened to uselessness.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');

/** Removes block and line comments and string-literal contents, leaving executable structure. */
function strippedSource(relativePath: string): string {
  const raw = readFileSync(join(SRC, relativePath), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The files that DECIDE entitlement, tier and access.
 *
 * `content-grant.signer.ts` is included on purpose even though it signs:
 * it resolves the adapter from `media_assets.provider` through the
 * registry, and the day it names an adapter class directly is the day
 * playback stops being routed by the asset (AD-7, AD-15).
 */
const AUTHORIZATION_LAYER = [
  'plans/services/video-tier.service.ts',
  'plans/services/entitlement.service.ts',
  'plans/services/entitlement-enforcement.service.ts',
  'learning/services/lesson-content.service.ts',
  'learning/services/learning-access.util.ts',
  'learning/services/content-grant.signer.ts',
  'learning/services/academy-protection.service.ts',
];

const PROVIDER_CLASS_NAMES = [
  'CloudflareStreamProvider',
  'BasicVideoProvider',
  'FakeVideoProvider',
];

describe('P64 Phase 2 §V — `premium` is never hard-wired to a provider class (D10)', () => {
  it.each(AUTHORIZATION_LAYER)('%s names no provider adapter class', (file) => {
    const source = strippedSource(file);
    for (const className of PROVIDER_CLASS_NAMES) {
      expect(source).not.toContain(className);
    }
  });

  it.each(AUTHORIZATION_LAYER)('%s contains no provider identifier literal', (file) => {
    const source = strippedSource(file);
    // The enum VALUES are how an asset is routed, and routing belongs to
    // `VideoProviderRegistry`. A decision layer that compared against one
    // of these would be deciding by provider instead of by tier.
    expect(source).not.toMatch(/['"`]cloudflare_stream['"`]/);
    expect(source).not.toMatch(/['"`]r2_worker['"`]/);
  });

  it('the tier → provider mapping lives in exactly one place', () => {
    const owners = walk(SRC).filter((file) => {
      if (file.endsWith('.spec.ts')) return false;
      const source = strippedSource(file.slice(SRC.length + 1));
      // "premium implies this provider" — the mapping itself.
      return (
        /['"`]premium['"`]/.test(source) && /['"`]cloudflare_stream['"`]/.test(source)
      );
    });

    expect(owners.map((file) => file.slice(SRC.length + 1))).toEqual([
      'media/video/video-provider.registry.ts',
    ]);
  });
});

describe('P64 Phase 2 §V — no provider price appears in the codebase (D5)', () => {
  /**
   * Provider BILLING is external and Atlas never depends on it. A rate in
   * the source is how a quota quietly turns into a resold price list, and
   * D5 forbids it in the codebase rather than only in the product.
   */
  const PRICE_SHAPED = [
    /pricePerMinute/i,
    /costPerMinute/i,
    /perMinute(Cost|Price|Usd)/i,
    /pricePerGb/i,
    /costPerGb/i,
    /perGb(Cost|Price|Usd)/i,
    /deliveryCost/i,
    /storageCost/i,
    /streamPricing/i,
    /minutesDelivered.*(price|cost)/i,
  ];

  it('no source file under src/media carries a provider rate', () => {
    const offenders: string[] = [];
    for (const file of walk(join(SRC, 'media'))) {
      const source = strippedSource(file.slice(SRC.length + 1));
      for (const pattern of PRICE_SHAPED) {
        if (pattern.test(source)) offenders.push(`${file}: ${String(pattern)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no source file anywhere pairs a video provider with a currency amount', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith('.spec.ts')) continue;
      const source = strippedSource(file.slice(SRC.length + 1));
      const mentionsProvider =
        /cloudflare_stream|CloudflareStream|videodelivery|cloudflarestream/i.test(source);
      if (!mentionsProvider) continue;
      for (const pattern of PRICE_SHAPED) {
        if (pattern.test(source)) offenders.push(`${file}: ${String(pattern)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
