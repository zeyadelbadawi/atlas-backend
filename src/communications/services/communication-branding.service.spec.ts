/**
 * Email branding — which academy identity and which logo URL an email gets.
 *
 * W3: the logo is NEVER the stored value any more. It is the platform-host
 * URL of the public logo route (from `EmailLogoService.forEmail`), or absent
 * (the layout then prints the academy name). `identity` decides whether an
 * academy's name/logo is shown; `mode` keeps deciding the link host.
 */
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { CommunicationBrandingService } from './communication-branding.service';
import type { LinkBuilderService } from './link-builder.service';
import type { EmailLogoService } from './email-logo.service';

const ACADEMY = '11111111-1111-4111-8111-111111111111';

function setup(logoUrl: string | null, host: string | null) {
  const config = {
    getOrThrow: () => ({ platformName: 'Atlas' }),
  } as unknown as ConfigService;
  const links = {
    platform: (path = '/') => `https://app.atlas.test${path}`,
    academyHost: jest.fn(async () => host),
    academyAtlasHost: jest.fn(async () => host),
  } as unknown as LinkBuilderService;
  const emailLogo = {
    forEmail: jest.fn(async (academyId: string, value: string | null) =>
      value && !value.startsWith('https://cdn')
        ? {
            url: `https://app.atlas.test/api/v1/public/websites/${academyId}/logo?v=abc`,
            width: 120,
            height: 40,
          }
        : undefined,
    ),
  } as unknown as EmailLogoService;
  const tx = {
    academy: {
      findUnique: async () => ({
        name: 'Horizon',
        logoUrl,
        language: 'en',
        timezone: 'UTC',
      }),
    },
  } as unknown as Prisma.TransactionClient;
  const service = new CommunicationBrandingService(config, links, emailLogo);
  return {
    links,
    emailLogo,
    resolve: (
      mode: 'academy' | 'platform' = 'academy',
      identity?: 'academy' | 'platform',
    ) => service.resolve(tx, mode, ACADEMY, identity),
  };
}

describe('email branding — academy logo URL', () => {
  const media = `/api/v1/public/media/academies/${ACADEMY}/22222222-2222-4222-8222-222222222222.png`;

  it('links an uploaded logo through the versioned public logo route, with its display size', async () => {
    const { branding, host } = await setup(media, 'horizon.atlas.test').resolve();
    expect(branding.academyLogoUrl).toBe(
      `https://app.atlas.test/api/v1/public/websites/${ACADEMY}/logo?v=abc`,
    );
    expect(branding.academyLogoWidth).toBe(120);
    expect(branding.academyLogoHeight).toBe(40);
    expect(branding.academyName).toBe('Horizon');
    expect(host).toBe('horizon.atlas.test');
  });

  it('never passes a data: URI or the raw stored value through to the email', async () => {
    const { branding } = await setup('data:image/png;base64,AAAA', 'h.test').resolve();
    expect(branding.academyLogoUrl).not.toContain('data:');
    expect(branding.academyLogoUrl).toMatch(
      /^https:\/\/app\.atlas\.test\/api\/v1\/public\/websites\//,
    );
  });

  it('falls back to text (no logo URL) when the logo is unusable or absent', async () => {
    expect(
      (await setup('https://cdn.x/l.png', 'h.test').resolve()).branding.academyLogoUrl,
    ).toBeUndefined();
    expect(
      (await setup(null, 'h.test').resolve()).branding.academyLogoUrl,
    ).toBeUndefined();
  });

  it('platform mode without an identity override keeps the platform brand (unchanged behaviour)', async () => {
    const { resolve, emailLogo } = setup(media, 'h.test');
    const resolved = await resolve('platform');
    expect(resolved.branding.academyName).toBeUndefined();
    expect(resolved.branding.academyLogoUrl).toBeUndefined();
    expect(resolved.host).toBeNull();
    expect(emailLogo.forEmail).not.toHaveBeenCalled();
  });

  it('platform HOST with academy IDENTITY: academy name and logo, links stay on the platform host', async () => {
    const { resolve, links } = setup(media, 'h.test');
    const resolved = await resolve('platform', 'academy');
    expect(resolved.branding.academyName).toBe('Horizon');
    expect(resolved.branding.academyLogoUrl).toContain('/logo?v=');
    expect(resolved.host).toBeNull();
    expect(resolved.branding.academyHost).toBeUndefined();
    expect(links.academyHost).not.toHaveBeenCalled();
  });
});
