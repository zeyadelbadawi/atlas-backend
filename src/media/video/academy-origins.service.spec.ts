import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { AcademyOriginsService } from './academy-origins.service';

describe('AcademyOriginsService — allowed playback origins', () => {
  const config = {
    get: jest.fn((key: string) =>
      key === 'platformDomain' ? { baseDomain: 'atlass.dpdns.org' } : undefined,
    ),
  } as unknown as ConfigService;

  it('allows the academy hosts plus the platform apex and the dashboard host, nothing else', async () => {
    const tx = {
      subdomainAllocation: {
        findUnique: jest.fn().mockResolvedValue({ subdomain: 'nour', fullHost: null }),
      },
      domainConnection: { findUnique: jest.fn().mockResolvedValue(null) },
    } as unknown as Prisma.TransactionClient;
    const origins = await new AcademyOriginsService(config).forAcademy(tx, 'a-1');
    expect([...origins].sort()).toEqual(
      [
        'https://atlass.dpdns.org',
        'https://dashboard.atlass.dpdns.org',
        'https://nour.atlass.dpdns.org',
      ].sort(),
    );
  });
});
