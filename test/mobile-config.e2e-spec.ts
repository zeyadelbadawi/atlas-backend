/**
 * Atlas mobile app — `GET /api/v1/public/mobile/config` (B5).
 *
 * Anonymous, on any host, operator-set values only. With nothing set it
 * says "every version supported, no links, no maintenance".
 */
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Mobile app config (e2e, B5)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: ['health', 'metrics'] });
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers the permissive default with no auth, cookies or tenant host', async () => {
    const config = app.get(ConfigService);
    const spy = jest.spyOn(config, 'get').mockImplementation(() => undefined);
    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/public/mobile/config')
        .expect(200);
      expect(response.body).toEqual({
        ios: { minimumVersion: '0.0.0', latestVersion: null, storeUrl: null },
        android: { minimumVersion: '0.0.0', latestVersion: null, storeUrl: null },
        maintenance: false,
        signInWithApple: false,
      });
      expect(response.headers['cache-control']).toBe('public, max-age=60');
      expect(response.headers['set-cookie']).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('reports exactly what the operator configured, per platform', async () => {
    const values: Record<string, string> = {
      MOBILE_MIN_VERSION_IOS: '1.2.0',
      MOBILE_LATEST_VERSION_IOS: '1.4.1',
      MOBILE_STORE_URL_IOS: 'https://apps.apple.com/app/id000000000',
      MOBILE_MIN_VERSION_ANDROID: '1.1.0',
      MOBILE_MAINTENANCE_MODE: 'true',
      FLAG_AUTH_APPLE_MODE: 'on',
      APPLE_CLIENT_IDS: 'com.atlas.learner',
    };
    const config = app.get(ConfigService);
    const spy = jest
      .spyOn(config, 'get')
      .mockImplementation((key: string) => values[key] as never);
    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/public/mobile/config')
        .set('Host', 'some-academy.atlass.dpdns.org')
        .expect(200);
      expect(response.body).toEqual({
        ios: {
          minimumVersion: '1.2.0',
          latestVersion: '1.4.1',
          storeUrl: 'https://apps.apple.com/app/id000000000',
        },
        android: { minimumVersion: '1.1.0', latestVersion: null, storeUrl: null },
        maintenance: true,
        signInWithApple: true,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('is read-only', async () => {
    await request(app.getHttpServer()).post('/api/v1/public/mobile/config').expect(404);
  });
});
