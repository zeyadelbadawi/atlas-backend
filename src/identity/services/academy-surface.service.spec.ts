import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../database/prisma.service';
import { AcademySurfaceService } from './academy-surface.service';

/**
 * Host classification for the dashboard subdomain move: the apex and the
 * dashboard host are both the platform (management surface, no academy);
 * every other single-label subdomain still resolves through the database.
 */
describe('AcademySurfaceService — platform hosts', () => {
  function build(rows: { academy_id: string }[] = []) {
    const queryRaw = jest.fn().mockResolvedValue(rows);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
    const config = {
      get: jest.fn((key: string) =>
        key === 'platformDomain' ? { baseDomain: 'atlass.dpdns.org' } : undefined,
      ),
    } as unknown as ConfigService;
    return { service: new AcademySurfaceService(prisma, config), queryRaw };
  }

  it.each([
    'atlass.dpdns.org',
    'dashboard.atlass.dpdns.org',
    'Dashboard.Atlass.dpdns.org:443',
  ])('%s is the platform: no academy, unresolvable, management context', async (host) => {
    const { service, queryRaw } = build([{ academy_id: 'never' }]);
    await expect(service.resolveHostAcademyId(host)).resolves.toBeNull();
    await expect(service.isUnresolvableHost(host)).resolves.toBe(true);
    await expect(service.expectedAuthContext(host)).resolves.toEqual({
      surface: 'management',
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('an academy subdomain still resolves through the database', async () => {
    const { service, queryRaw } = build([{ academy_id: 'a-1' }]);
    await expect(service.resolveHostAcademyId('nour.atlass.dpdns.org')).resolves.toBe(
      'a-1',
    );
    await expect(service.isUnresolvableHost('nour.atlass.dpdns.org')).resolves.toBe(
      false,
    );
    await expect(service.expectedAuthContext('nour.atlass.dpdns.org')).resolves.toEqual({
      surface: 'academy',
      academyId: 'a-1',
    });
    expect(queryRaw).toHaveBeenCalled();
  });

  it('a look-alike of the dashboard host is not the platform', async () => {
    const { service } = build([]);
    for (const host of [
      'dashboard.atlass.dpdns.org.evil.com',
      'xdashboard.atlass.dpdns.org',
    ]) {
      await expect(service.isUnresolvableHost(host)).resolves.toBe(false);
      await expect(service.expectedAuthContext(host)).resolves.toBeNull();
    }
  });

  it('an academy id claimed on the dashboard host is taken as given (preview), as on the apex', async () => {
    const { service } = build([]);
    await expect(
      service.assertAcademyMatchesHost('a-1', 'dashboard.atlass.dpdns.org'),
    ).resolves.toBeUndefined();
  });
});
