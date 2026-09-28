/**
 * A local stand-in for Google's OpenID Connect endpoints, for the Google
 * Identity e2e suite. It never stands in for the CLIENT: the backend's real
 * `GoogleOidcClient` exchanges codes against it and verifies its ID tokens
 * with the same checks it applies to Google (signature by `kid`, issuer,
 * audience, expiry, nonce).
 *
 *   GET  /jwks   — the public signing key(s)
 *   POST /token  — exchanges a code the TEST registered (standing in for
 *                  "the person signed in at Google"), enforcing the client
 *                  id/secret, the redirect URI and PKCE (S256) like Google.
 */
import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeGoogleConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface IdTokenOverrides {
  readonly iss?: string;
  readonly aud?: string | string[];
  readonly azp?: string;
  readonly exp?: number;
  readonly iat?: number;
  readonly nonce?: string;
  /** Sign with a key the JWKS does not publish (under the published `kid`). */
  readonly forgeSignature?: boolean;
  readonly kid?: string;
}

export interface FakeSignIn {
  readonly sub: string;
  readonly email: string;
  readonly emailVerified?: boolean;
  readonly hd?: string;
  readonly name?: string;
  readonly overrides?: IdTokenOverrides;
}

const KID = 'fake-google-key-1';

export class FakeGoogleOidc {
  private server?: Server;
  private readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly forgeKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  private readonly codes = new Map<
    string,
    { signIn: FakeSignIn; nonce: string; codeChallenge: string }
  >();
  baseUrl = '';
  tokenRequests = 0;

  constructor(private readonly config: FakeGoogleConfig) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/jwks') {
        const jwk = this.key.publicKey.export({ format: 'jwk' });
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] }),
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/token') {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          this.tokenRequests += 1;
          const form = new URLSearchParams(raw);
          const reject = (status: number, error: string) => {
            res.statusCode = status;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error }));
          };
          if (
            form.get('client_id') !== this.config.clientId ||
            form.get('client_secret') !== this.config.clientSecret
          ) {
            return reject(401, 'invalid_client');
          }
          if (form.get('redirect_uri') !== this.config.redirectUri) {
            return reject(400, 'redirect_uri_mismatch');
          }
          const code = form.get('code') ?? '';
          const entry = this.codes.get(code);
          // Codes are single-use, as at Google.
          this.codes.delete(code);
          if (!entry) return reject(400, 'invalid_grant');
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (challenge !== entry.codeChallenge) return reject(400, 'invalid_grant');
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              access_token: 'fake-access-token',
              expires_in: 3599,
              token_type: 'Bearer',
              scope: 'openid email profile',
              id_token: this.idToken(entry.signIn, entry.nonce),
            }),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  /**
   * "The person signed in at Google": registers a code bound to the
   * authorization request's nonce and PKCE challenge, as Google would.
   */
  approve(authorizationUrl: string, signIn: FakeSignIn): { code: string; state: string } {
    const url = new URL(authorizationUrl);
    const code = `code-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    this.codes.set(code, {
      signIn,
      nonce: url.searchParams.get('nonce') ?? '',
      codeChallenge: url.searchParams.get('code_challenge') ?? '',
    });
    return { code, state: url.searchParams.get('state') ?? '' };
  }

  private idToken(signIn: FakeSignIn, nonce: string): string {
    const o = signIn.overrides ?? {};
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: o.kid ?? KID, typ: 'JWT' };
    const payload: Record<string, unknown> = {
      iss: o.iss ?? this.config.issuer,
      aud: o.aud ?? this.config.clientId,
      ...(o.azp ? { azp: o.azp } : {}),
      sub: signIn.sub,
      email: signIn.email,
      email_verified: signIn.emailVerified ?? true,
      ...(signIn.hd ? { hd: signIn.hd } : {}),
      ...(signIn.name ? { name: signIn.name } : {}),
      iat: o.iat ?? now,
      exp: o.exp ?? now + 3600,
      nonce: o.nonce ?? nonce,
    };
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode(header)}.${encode(payload)}`;
    const key: KeyObject = o.forgeSignature
      ? this.forgeKey.privateKey
      : this.key.privateKey;
    const signature = createSign('RSA-SHA256')
      .update(input)
      .sign(key)
      .toString('base64url');
    return `${input}.${signature}`;
  }
}
