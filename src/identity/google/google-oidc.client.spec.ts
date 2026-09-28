import { createSign, generateKeyPairSync } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { GoogleOidcClient, GoogleOidcError } from './google-oidc.client';
import { hashFlowSecret } from './google-flow.util';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const NONCE = 'nonce-value-abc';

function client(): GoogleOidcClient {
  const config = {
    getOrThrow: () => ({
      mode: 'on',
      academyIds: [],
      platform: false,
      clientId: CLIENT_ID,
      clientSecret: 'secret',
      redirectUri: 'https://atlas.test/api/v1/auth/google/callback',
      issuer: 'https://accounts.google.com',
      acceptedIssuers: ['https://accounts.google.com', 'accounts.google.com'],
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    }),
  } as unknown as ConfigService;
  return new GoogleOidcClient(config);
}

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

function token(
  payload: Record<string, unknown>,
  opts: { kid?: string; forge?: boolean; alg?: string } = {},
) {
  const enc = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input = `${enc({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1' })}.${enc(payload)}`;
  const sig = createSign('RSA-SHA256')
    .update(input)
    .sign((opts.forge ? other : key).privateKey)
    .toString('base64url');
  return `${input}.${sig}`;
}

function claims(over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1234567890',
    email: 'Person@Gmail.com',
    email_verified: true,
    name: 'Person Name',
    iat: now,
    exp: now + 3600,
    nonce: NONCE,
    ...over,
  };
}

describe('GoogleOidcClient.verifyIdToken', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            keys: [
              {
                ...key.publicKey.export({ format: 'jwk' }),
                kid: 'k1',
                alg: 'RS256',
                use: 'sig',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  it('accepts a valid token and returns only the identity claims (email normalized)', async () => {
    const result = await client().verifyIdToken(token(claims()), hashFlowSecret(NONCE));
    expect(result).toEqual({
      subject: '1234567890',
      email: 'person@gmail.com',
      emailVerified: true,
      hostedDomain: null,
      name: 'Person Name',
    });
  });

  it('accepts the bare issuer form Google also uses, and a Workspace hd', async () => {
    const result = await client().verifyIdToken(
      token(
        claims({ iss: 'accounts.google.com', hd: 'Company.com', email: 'a@company.com' }),
      ),
      hashFlowSecret(NONCE),
    );
    expect(result.hostedDomain).toBe('company.com');
  });

  it.each([
    ['forged signature', claims(), { forge: true }],
    ['wrong issuer', claims({ iss: 'https://evil.example' }), {}],
    ['wrong audience', claims({ aud: 'other-client' }), {}],
    [
      'multiple audiences without our azp',
      claims({ aud: [CLIENT_ID, 'x'], azp: 'x' }),
      {},
    ],
    ['expired', claims({ exp: Math.floor(Date.now() / 1000) - 600 }), {}],
    ['issued in the future', claims({ iat: Math.floor(Date.now() / 1000) + 600 }), {}],
    ['nonce mismatch', claims({ nonce: 'other' }), {}],
    ['missing nonce', claims({ nonce: undefined }), {}],
    ['missing subject', claims({ sub: '' }), {}],
    ['missing email', claims({ email: undefined }), {}],
    ['alg none', claims(), { alg: 'none' }],
    ['alg HS256', claims(), { alg: 'HS256' }],
    ['unknown kid', claims(), { kid: 'nope' }],
  ])('rejects: %s', async (_label, payload, opts) => {
    await expect(
      client().verifyIdToken(token(payload, opts), hashFlowSecret(NONCE)),
    ).rejects.toMatchObject({ kind: 'invalid_token' });
  });

  it('treats email_verified other than true as unverified', async () => {
    const result = await client().verifyIdToken(
      token(claims({ email_verified: false })),
      hashFlowSecret(NONCE),
    );
    expect(result.emailVerified).toBe(false);
  });

  it('refetches the JWKS for an unknown kid at most once a minute', async () => {
    const c = client();
    await c.verifyIdToken(token(claims()), hashFlowSecret(NONCE));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i += 1) {
      await expect(
        c.verifyIdToken(token(claims(), { kid: `forged-${i}` }), hashFlowSecret(NONCE)),
      ).rejects.toBeInstanceOf(GoogleOidcError);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('Google unreachable with no cached key is a provider error, not a bad token', async () => {
    fetchSpy.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      client().verifyIdToken(token(claims()), hashFlowSecret(NONCE)),
    ).rejects.toMatchObject({ kind: 'provider_error' });
  });

  it('the authorization URL asks for openid email profile with PKCE S256 and account choice', () => {
    const url = new URL(
      client().authorizationUrl({ state: 's', nonce: 'n', codeChallenge: 'c' }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'https://atlas.test/api/v1/auth/google/callback',
      scope: 'openid email profile',
      state: 's',
      nonce: 'n',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      prompt: 'select_account',
      access_type: 'online',
    });
  });
});
