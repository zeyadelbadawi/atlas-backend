import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { AppleIdTokenVerifier, AppleTokenError } from './apple-id-token.verifier';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const NONCE = 'raw-nonce-0123456789abcdef';
const now = () => Math.floor(Date.now() / 1000);

function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' },
  key = privateKey,
): string {
  const payload = {
    iss: 'https://appleid.apple.com',
    aud: 'com.atlas.learner',
    exp: now() + 600,
    iat: now(),
    sub: '001234.abcdef.1234',
    email: 'Student@PrivateRelay.AppleID.com',
    email_verified: 'true',
    is_private_email: 'true',
    nonce: createHash('sha256').update(NONCE).digest('hex'),
    ...claims,
  };
  const signingInput = `${b64(header)}.${b64(payload)}`;
  return `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url')}`;
}

const jwks = (async () =>
  new Response(
    JSON.stringify({
      keys: [{ kid: 'k1', kty: 'RSA', use: 'sig', alg: 'RS256', ...jwk }],
    }),
    {
      status: 200,
    },
  )) as unknown as typeof fetch;

const verifier = () =>
  new AppleIdTokenVerifier(['com.atlas.learner'], jwks, 'https://jwks.test');

describe('AppleIdTokenVerifier', () => {
  it('accepts a valid token and normalises the claims', async () => {
    await expect(verifier().verify(token(), NONCE)).resolves.toEqual({
      subject: '001234.abcdef.1234',
      email: 'student@privaterelay.appleid.com',
      isPrivateEmail: true,
      clientId: 'com.atlas.learner',
    });
  });

  it.each([
    ['a forged signature', token({}, undefined, other.privateKey)],
    ['the wrong issuer', token({ iss: 'https://evil.test' })],
    ['another app', token({ aud: 'com.other.app' })],
    ['an expired token', token({ exp: now() - 3600 })],
    ['a token from the future', token({ iat: now() + 3600 })],
    ['a nonce mismatch', token({ nonce: 'abc' })],
    ['no subject', token({ sub: '' })],
    ['no email', token({ email: undefined })],
    ['an unverified email', token({ email_verified: false })],
    ['alg none', token({}, { alg: 'none', kid: 'k1' })],
    ['an unknown key', token({}, { alg: 'RS256', kid: 'nope' })],
  ])('refuses %s', async (_label, value) => {
    await expect(verifier().verify(value, NONCE)).rejects.toBeInstanceOf(AppleTokenError);
  });

  it('a JWKS outage is a provider error, not a bad token', async () => {
    const down = (async () =>
      new Response('', { status: 503 })) as unknown as typeof fetch;
    const v = new AppleIdTokenVerifier(['com.atlas.learner'], down, 'https://jwks.test');
    await expect(v.verify(token(), NONCE)).rejects.toMatchObject({
      kind: 'provider_error',
    });
  });
});
