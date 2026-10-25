/**
 * Atlas mobile app — the App Links / Universal Links files
 * (`GET /api/v1/public/mobile/assetlinks.json` and
 * `/apple-app-site-association`; Caddy serves them at `/.well-known/`).
 *
 * Anonymous, on any host. 404 while the operator has not set the signing
 * values, so links keep opening in the browser until then.
 */
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';

const FINGERPRINT = Array.from({ length: 32 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
).join(':');

describe('Mobile app links (e2e)', () => {
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

  function withConfig(values: Record<string, string>): jest.SpyInstance {
    const config = app.get(ConfigService);
    return jest
      .spyOn(config, 'get')
      .mockImplementation((key: string) => values[key] as never);
  }

  it('answers 404 for both files while nothing is set', async () => {
    const spy = withConfig({});
    try {
      await request(app.getHttpServer())
        .get('/api/v1/public/mobile/assetlinks.json')
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/v1/public/mobile/apple-app-site-association')
        .expect(404);
    } finally {
      spy.mockRestore();
    }
  });

  it('states the Android app and its signing fingerprints', async () => {
    const spy = withConfig({
      MOBILE_ANDROID_CERT_SHA256: `${FINGERPRINT}, ${FINGERPRINT.toUpperCase()}`,
    });
    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/public/mobile/assetlinks.json')
        .set('Host', 'some-academy.atlass.dpdns.org')
        .expect(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.body).toEqual([
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: 'com.atlas.atlas_mobile',
            sha256_cert_fingerprints: [
              FINGERPRINT.toUpperCase(),
              FINGERPRINT.toUpperCase(),
            ],
          },
        },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it('associates the iOS app with the pages the app shows, never paying ones', async () => {
    const spy = withConfig({ MOBILE_IOS_APP_IDS: 'ABCDE12345.com.atlas.learner' });
    try {
      const response = await request(app.getHttpServer())
        .get('/api/v1/public/mobile/apple-app-site-association')
        .expect(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      const [detail] = response.body.applinks.details;
      expect(detail.appIDs).toEqual(['ABCDE12345.com.atlas.learner']);
      const paths = detail.components.map(
        (c: { '/': string; exclude?: boolean }) => `${c.exclude ? '!' : ''}${c['/']}`,
      );
      for (const p of ['', '/ar', '/en']) {
        expect(paths).toEqual(
          expect.arrayContaining([
            `!${p}/my/purchases*`,
            `!${p}/my/payments*`,
            `!${p}/my/courses/*/checkout*`,
            `${p}/courses/*`,
            `${p}/my/*`,
            `${p}/verify-email`,
            `${p}/reset-password`,
          ]),
        );
        // An exclusion only works when it comes before the broad /my/* match.
        expect(paths.indexOf(`!${p}/my/purchases*`)).toBeLessThan(
          paths.indexOf(`${p}/my/*`),
        );
      }
    } finally {
      spy.mockRestore();
    }
  });
});
