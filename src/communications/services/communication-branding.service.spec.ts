import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { CommunicationBrandingService } from './communication-branding.service';
import type { LinkBuilderService } from './link-builder.service';

function setup(logoUrl: string | null, host: string | null) {
  const config = {
    getOrThrow: () => ({ platformName: 'Atlas' }),
  } as unknown as ConfigService;
  const links = {
    platform: (path = '/') => `https://app.atlas.test${path}`,
    academyHost: async () => host,
  } as unknown as LinkBuilderService;
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
  const service = new CommunicationBrandingService(config, links);
  return () => service.resolve(tx, 'academy', 'a1');
}

describe('email branding — academy logo URL', () => {
  const media = '/api/v1/public/media/academies/a1/logo.png';

  it('resolves an uploaded (relative) logo against the academy host', async () => {
    const { branding } = await setup(media, 'horizon.atlas.test')();
    expect(branding.academyLogoUrl).toBe(`https://horizon.atlas.test${media}`);
  });

  it('falls back to the platform URL when the academy has no host', async () => {
    const { branding } = await setup(media, null)();
    expect(branding.academyLogoUrl).toBe(`https://app.atlas.test${media}`);
  });

  it('leaves absolute and legacy values, and no logo, as they were', async () => {
    expect((await setup('https://cdn.x/l.png', 'h.test')()).branding.academyLogoUrl).toBe(
      'https://cdn.x/l.png',
    );
    expect(
      (await setup('data:image/png;base64,AAAA', 'h.test')()).branding.academyLogoUrl,
    ).toBe('data:image/png;base64,AAAA');
    expect((await setup(null, 'h.test')()).branding.academyLogoUrl).toBeUndefined();
  });
});
