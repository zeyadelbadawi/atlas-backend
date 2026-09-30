import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import {
  CertificateImageLoader,
  MAX_CERTIFICATE_IMAGE_BYTES,
  resolvePublicAddress,
  type AddressResolver,
} from './certificate-image-loader.service';
import type { MediaStorageProvider } from '../../media/storage/media-storage.interface';

const ACADEMY = '11111111-1111-4111-8111-111111111111';
const OBJECT = '22222222-2222-4222-8222-222222222222';
const OWN_PATH = `/api/v1/public/media/academies/${ACADEMY}/${OBJECT}.png`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function storage(
  objects: Record<string, Buffer> = {},
): jest.Mocked<MediaStorageProvider> {
  return {
    putObject: jest.fn(),
    getObject: jest.fn(async (key: string) => {
      const found = objects[key];
      if (!found) throw new Error('NoSuchKey');
      return found;
    }),
    deleteObject: jest.fn(),
    objectExists: jest.fn(),
  };
}

const config = (baseDomain: string | null) =>
  ({
    get: (key: string) => (key === 'platformDomain' ? { baseDomain } : undefined),
  }) as unknown as ConfigService;

/** Connects to a local test server instead of the scheme's standard port. */
class LocalPortLoader extends CertificateImageLoader {
  constructor(
    store: MediaStorageProvider,
    resolver: AddressResolver,
    private readonly port: number,
  ) {
    super(store, config('atlass.dpdns.org'), resolver);
  }
  protected portFor(): number {
    return this.port;
  }
}

describe('CertificateImageLoader', () => {
  describe('own media', () => {
    it('reads a relative public media path from storage, never over HTTP', async () => {
      const store = storage({ [`academies/${ACADEMY}/${OBJECT}.png`]: PNG });
      const resolver = jest.fn<
        ReturnType<AddressResolver>,
        Parameters<AddressResolver>
      >();
      const loader = new CertificateImageLoader(
        store,
        config('atlass.dpdns.org'),
        resolver,
      );
      const warnings: string[] = [];
      await expect(loader.load(OWN_PATH, 'logo', warnings)).resolves.toEqual(PNG);
      expect(store.getObject).toHaveBeenCalledWith(`academies/${ACADEMY}/${OBJECT}.png`);
      expect(resolver).not.toHaveBeenCalled();
      expect(warnings).toEqual([]);
    });

    it('reads an absolute URL on the platform domain or a subdomain from storage', async () => {
      const store = storage({ [`academies/${ACADEMY}/${OBJECT}.png`]: PNG });
      const resolver = jest.fn<
        ReturnType<AddressResolver>,
        Parameters<AddressResolver>
      >();
      const loader = new CertificateImageLoader(
        store,
        config('atlass.dpdns.org'),
        resolver,
      );
      for (const host of ['atlass.dpdns.org', 'my-academy.atlass.dpdns.org']) {
        await expect(
          loader.load(`https://${host}${OWN_PATH}`, 'logo', []),
        ).resolves.toEqual(PNG);
      }
      expect(resolver).not.toHaveBeenCalled();
    });

    it('treats the same path on a foreign host as an external URL', () => {
      const loader = new CertificateImageLoader(storage(), config('atlass.dpdns.org'));
      expect(loader.ownMediaKey(`https://evil.example${OWN_PATH}`)).toBeNull();
      expect(
        loader.ownMediaKey(`https://atlass.dpdns.org.evil.example${OWN_PATH}`),
      ).toBeNull();
    });

    it('accepts only the strict public media shape', () => {
      const loader = new CertificateImageLoader(storage(), config('atlass.dpdns.org'));
      expect(
        loader.ownMediaKey(`/api/v1/public/media/academies/${ACADEMY}/../x.png`),
      ).toBeNull();
      expect(
        loader.ownMediaKey(`/api/v1/public/media/academies/${ACADEMY}/${OBJECT}.pdf`),
      ).toBeNull();
      expect(
        loader.ownMediaKey(`/api/v1/protected/media/academies/${ACADEMY}/${OBJECT}.png`),
      ).toBeNull();
      expect(loader.ownMediaKey(`https://atlass.dpdns.org${OWN_PATH}?x=1`)).toBeNull();
    });

    it('warns when the media object is missing', async () => {
      const loader = new CertificateImageLoader(storage(), config(null));
      const warnings: string[] = [];
      await expect(loader.load(OWN_PATH, 'signature', warnings)).resolves.toBeNull();
      expect(warnings).toEqual(['signature: media not found']);
    });
  });

  describe('data URIs', () => {
    const loader = new CertificateImageLoader(storage(), config(null));

    it('decodes a base64 image in-process', async () => {
      const uri = `data:image/png;base64,${PNG.toString('base64')}`;
      await expect(loader.load(uri, 'logo', [])).resolves.toEqual(PNG);
    });

    it('refuses non-image and oversized data URIs', async () => {
      const warnings: string[] = [];
      await expect(
        loader.load('data:text/html;base64,PGgxPg==', 'logo', warnings),
      ).resolves.toBeNull();
      const big = Buffer.alloc(MAX_CERTIFICATE_IMAGE_BYTES + 10).toString('base64');
      await expect(
        loader.load(`data:image/png;base64,${big}`, 'logo', warnings),
      ).resolves.toBeNull();
      expect(warnings).toEqual(['logo: unsupported data URI', 'logo: too large']);
    });
  });

  describe('external URLs', () => {
    it('refuses loopback, private, link-local (metadata) and IPv6 literals', async () => {
      const loader = new CertificateImageLoader(storage(), config(null));
      for (const url of [
        'http://127.0.0.1/logo.png',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.5/logo.png',
        'http://[::1]/logo.png',
        'http://0x7f000001/logo.png',
      ]) {
        const warnings: string[] = [];
        await expect(loader.load(url, 'logo', warnings)).resolves.toBeNull();
        expect(warnings[0]).toMatch(/^logo: address refused/);
      }
    });

    it('refuses a hostname that resolves to a non-public address', async () => {
      await expect(resolvePublicAddress('localhost')).resolves.toEqual({
        refused: 'non_public_address',
      });
    });

    it('refuses other schemes, non-standard ports and embedded credentials', async () => {
      const resolver = jest.fn<
        ReturnType<AddressResolver>,
        Parameters<AddressResolver>
      >();
      const loader = new CertificateImageLoader(storage(), config(null), resolver);
      const warnings: string[] = [];
      await loader.load('file:///etc/passwd', 'logo', warnings);
      await loader.load('https://cdn.example.com:6379/logo.png', 'logo', warnings);
      await loader.load('https://user:pw@cdn.example.com/logo.png', 'logo', warnings);
      await loader.load('ftp://cdn.example.com/logo.png', 'logo', warnings);
      expect(warnings).toEqual([
        'logo: unsupported URL scheme',
        'logo: non-standard port refused',
        'logo: credentials in URL refused',
        'logo: unsupported URL scheme',
      ]);
      expect(resolver).not.toHaveBeenCalled();
    });

    describe('against a vetted host', () => {
      let server: Server;
      let port: number;
      const hits: string[] = [];
      beforeAll(async () => {
        server = createServer((req, res) => {
          hits.push(req.url ?? '');
          if (req.url === '/redirect') {
            res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
            res.end();
          } else if (req.url === '/huge') {
            res.writeHead(200, { 'content-type': 'image/png' });
            const chunk = Buffer.alloc(256 * 1024);
            for (let i = 0; i < 12; i += 1) res.write(chunk);
            res.end();
          } else if (req.url === '/missing') {
            res.writeHead(404);
            res.end();
          } else {
            res.writeHead(200, { 'content-type': 'image/png' });
            res.end(PNG);
          }
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        port = (server.address() as AddressInfo).port;
      });
      afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

      // Pretend cdn.example.com vetted as public and pin it to the test server.
      const pinned: AddressResolver = async () => ({ address: '127.0.0.1', family: 4 });

      it('fetches through the pinned address', async () => {
        const loader = new LocalPortLoader(storage(), pinned, port);
        const warnings: string[] = [];
        await expect(
          loader.load('http://cdn.example.com/logo.png', 'logo', warnings),
        ).resolves.toEqual(PNG);
        expect(warnings).toEqual([]);
      });

      it('never follows a redirect', async () => {
        const loader = new LocalPortLoader(storage(), pinned, port);
        const warnings: string[] = [];
        hits.length = 0;
        await expect(
          loader.load('http://cdn.example.com/redirect', 'logo', warnings),
        ).resolves.toBeNull();
        expect(warnings).toEqual(['logo: redirect refused']);
        expect(hits).toEqual(['/redirect']);
      });

      it('caps a streamed body without a content-length', async () => {
        const loader = new LocalPortLoader(storage(), pinned, port);
        const warnings: string[] = [];
        await expect(
          loader.load('http://cdn.example.com/huge', 'logo', warnings),
        ).resolves.toBeNull();
        expect(warnings).toEqual(['logo: too large']);
      });

      it('reports a non-2xx status', async () => {
        const loader = new LocalPortLoader(storage(), pinned, port);
        const warnings: string[] = [];
        await expect(
          loader.load('http://cdn.example.com/missing', 'logo', warnings),
        ).resolves.toBeNull();
        expect(warnings).toEqual(['logo: HTTP 404']);
      });
    });
  });
});
