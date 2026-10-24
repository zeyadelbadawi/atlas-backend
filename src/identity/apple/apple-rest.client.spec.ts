import { generateKeyPairSync, verify } from 'node:crypto';
import { AppleRestClient } from './apple-rest.client';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const key = {
  teamId: 'TEAM123456',
  keyId: 'KEY1234567',
  privateKey: pem.replace(/\n/g, '\\n'),
};

describe('AppleRestClient', () => {
  it('signs an ES256 client secret Apple can verify', () => {
    const secret = new AppleRestClient(key).clientSecret(
      'com.atlas.learner',
      1_800_000_000,
    );
    const [h, c, s] = secret.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({
      alg: 'ES256',
      kid: 'KEY1234567',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({
      iss: 'TEAM123456',
      iat: 1_800_000_000,
      exp: 1_800_000_300,
      aud: 'https://appleid.apple.com',
      sub: 'com.atlas.learner',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s, 'base64url'),
      ),
    ).toBe(true);
  });

  it('exchanges a code and revokes, never throwing', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      return url.endsWith('/auth/token')
        ? new Response(JSON.stringify({ refresh_token: 'r-1' }), { status: 200 })
        : new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const client = new AppleRestClient(key, fake);
    await expect(client.exchangeCode('com.atlas.learner', 'code-1')).resolves.toBe('r-1');
    await expect(client.revoke('com.atlas.learner', 'r-1')).resolves.toBe(true);
    expect(calls).toEqual([
      'https://appleid.apple.com/auth/token',
      'https://appleid.apple.com/auth/revoke',
    ]);

    const broken = new AppleRestClient(key, (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch);
    await expect(broken.exchangeCode('com.atlas.learner', 'c')).resolves.toBeNull();
    await expect(broken.revoke('com.atlas.learner', 'r')).resolves.toBe(false);
  });

  it('without a signing key it does nothing', async () => {
    const client = new AppleRestClient(null);
    expect(client.configured).toBe(false);
    await expect(client.exchangeCode('x', 'y')).resolves.toBeNull();
    await expect(client.revoke('x', 'y')).resolves.toBe(false);
  });
});
