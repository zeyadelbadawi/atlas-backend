/**
 * The registry is where "which adapter" is decided, and getting it wrong
 * has two distinct failure modes that these tests pin down separately:
 *
 *   - resolving an EXISTING asset by anything other than its recorded
 *     provider would route it to an edge that cannot honour its
 *     credential — the concrete consequence of finding D-1;
 *   - resolving an UPLOAD by anything other than the entitled tier would
 *     deliver Normal-tier protection to an academy that bought Premium.
 *
 * Both axes are therefore asserted independently (AD-7).
 */
import { VideoProviderRegistry } from './video-provider.registry';
import type { CloudflareStreamProvider } from './cloudflare-stream.provider';
import type { BasicVideoProvider } from './basic-video.provider';
import type { FakeVideoProvider } from './fake-video.provider';

function adapter(
  key: string,
  storedAs: string,
  configured: boolean,
): CloudflareStreamProvider {
  return {
    key,
    storedAs,
    isConfigured: () => configured,
  } as unknown as CloudflareStreamProvider;
}

const cloudflare = (configured = true) =>
  adapter('cloudflare_stream', 'cloudflare_stream', configured);
const basic = (configured = true) =>
  adapter('r2_worker', 'r2_worker', configured) as unknown as BasicVideoProvider;
const fake = () => adapter('fake', 'r2_worker', true) as unknown as FakeVideoProvider;

describe('VideoProviderRegistry — resolving by TIER (the upload axis)', () => {
  it('sends premium to Cloudflare Stream and normal to the R2 gate', () => {
    const registry = new VideoProviderRegistry(cloudflare(), basic(), fake());
    expect(registry.forTier('premium').storedAs).toBe('cloudflare_stream');
    expect(registry.forTier('normal').storedAs).toBe('r2_worker');
  });

  it('refuses a tier whose provider is not configured rather than downgrading it', () => {
    // The silent-downgrade failure is the dangerous one: an academy that
    // bought Premium would receive Normal-tier protection and nobody
    // would be told. Throwing turns that into a refused upload.
    const registry = new VideoProviderRegistry(cloudflare(false), basic(), fake());
    expect(() => registry.forTier('premium')).toThrow(/not configured/);
    expect(registry.forTier('normal').storedAs).toBe('r2_worker');
  });

  it('reports tier availability without throwing, for the upload gate to check first', () => {
    const registry = new VideoProviderRegistry(cloudflare(false), basic(), fake());
    expect(registry.isTierAvailable('premium')).toBe(false);
    expect(registry.isTierAvailable('normal')).toBe(true);
  });

  it('falls back to the local stand-in only while the real normal adapter is unconfigured', () => {
    const standIn = fake();
    const registry = new VideoProviderRegistry(cloudflare(), basic(false), standIn);
    expect(registry.forTier('normal')).toBe(standIn);

    const real = basic(true);
    const configured = new VideoProviderRegistry(cloudflare(), real, standIn);
    // A configured real adapter must always win — a deployment must never
    // silently serve through the stand-in.
    expect(configured.forTier('normal')).toBe(real);
  });
});

describe('VideoProviderRegistry — resolving by PROVIDER (the playback axis)', () => {
  it('routes an existing asset back to the adapter recorded on it', () => {
    const registry = new VideoProviderRegistry(cloudflare(), basic(), fake());
    expect(registry.forProvider('cloudflare_stream').storedAs).toBe('cloudflare_stream');
    expect(registry.forProvider('r2_worker').storedAs).toBe('r2_worker');
  });

  it('throws for a provider it has no adapter for, rather than guessing', () => {
    const registry = new VideoProviderRegistry(cloudflare(), basic(), fake());
    // `r2` is the protected FILE tier and is never a video adapter.
    expect(() => registry.forProvider('r2')).toThrow(/No video provider adapter/);
  });

  it('keeps playback resolution independent of what the academy is entitled to NOW (D11)', () => {
    // An academy that downgraded to Normal still has Premium assets, and
    // they must still resolve to the Premium adapter. The registry has no
    // access to the plan at all, which is what guarantees this — asserted
    // here so a future refactor cannot quietly add one.
    const registry = new VideoProviderRegistry(cloudflare(), basic(), fake());
    expect(registry.forProvider('cloudflare_stream').storedAs).toBe('cloudflare_stream');
  });
});
