/**
 * The Zoom authorization flow's security properties.
 *
 * Almost everything here is about REFUSING, because an OAuth flow's
 * failure modes are not "it didn't work" — they are "somebody else's
 * authorization was completed", "a captured callback was replayed", and
 * "a live token was overwritten with a dead one and nobody noticed until
 * a class failed to start".
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { ZoomOAuthService } from './zoom-oauth.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CredentialEncryptionService } from '../../billing/utils/credential-encryption.util';

const ACADEMY_ID = 'academy-1';
const ORG_ID = 'org-1';
const USER_ID = 'user-1';

const CONFIGURED = {
  clientId: 'atlas-client-id',
  clientSecret: 'atlas-client-secret',
  redirectUri: 'https://atlass.dpdns.org/dashboard/add-ons/live-sessions/connection',
};

describe('ZoomOAuthService', () => {
  let service: ZoomOAuthService;
  let stateCreate: jest.Mock;
  let stateUpdateMany: jest.Mock;
  let stateFindUnique: jest.Mock;
  let connFindUnique: jest.Mock;
  let connUpdateMany: jest.Mock;
  let encrypt: jest.Mock;
  let decrypt: jest.Mock;
  let zoomConfig: Record<string, string | undefined>;

  beforeEach(async () => {
    zoomConfig = { ...CONFIGURED };
    stateCreate = jest.fn().mockResolvedValue({});
    stateUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    stateFindUnique = jest
      .fn()
      .mockResolvedValue({ academyId: ACADEMY_ID, organizationId: ORG_ID });
    connFindUnique = jest.fn();
    connUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    // A reversible stand-in: the real AES-GCM envelope is already covered
    // by `credential-encryption.util.spec.ts`, and re-testing it here
    // would test that file rather than this one.
    encrypt = jest.fn((plain: string) => `enc(${plain})`);
    decrypt = jest.fn((cipher: string) => cipher.replace(/^enc\(|\)$/g, ''));

    const tx = {
      liveProviderOAuthState: {
        create: stateCreate,
        updateMany: stateUpdateMany,
        findUnique: stateFindUnique,
      },
      academyLiveProviderConnection: {
        findUnique: connFindUnique,
        updateMany: connUpdateMany,
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ZoomOAuthService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'zoom' ? zoomConfig : undefined) },
        },
        {
          provide: TenancyContextService,
          useValue: {
            runInUserContext: (_u: string, fn: (t: unknown) => unknown) => fn(tx),
            runInTenantContext: (_o: string, fn: (t: unknown) => unknown) => fn(tx),
          },
        },
        { provide: CredentialEncryptionService, useValue: { encrypt, decrypt } },
      ],
    }).compile();

    service = moduleRef.get(ZoomOAuthService);
  });

  describe('configuration', () => {
    it('reports configured when Atlas has a client id, secret and redirect uri', () => {
      expect(service.isConfigured()).toBe(true);
    });

    /*
     * No Zoom application exists in any Atlas environment yet, and the
     * platform must run anyway — the screen says "not configured" rather
     * than the process refusing to boot.
     */
    it.each(['clientId', 'clientSecret', 'redirectUri'])(
      'reports NOT configured when %s is missing',
      (field) => {
        zoomConfig[field] = undefined;
        expect(service.isConfigured()).toBe(false);
      },
    );

    it('refuses to start an authorization when Atlas is not configured', async () => {
      zoomConfig.clientId = undefined;
      await expect(
        service.createAuthorization({
          academyId: ACADEMY_ID,
          organizationId: ORG_ID,
          userId: USER_ID,
        }),
      ).rejects.toMatchObject({
        response: { messageKey: 'errors.liveSessions.providerNotConfigured' },
      });
    });
  });

  describe('createAuthorization', () => {
    const authorize = () =>
      service.createAuthorization({
        academyId: ACADEMY_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
      });

    it('sends the customer to Zoom with Atlas credentials and the exact redirect uri', async () => {
      const { authorizationUrl } = await authorize();
      const url = new URL(authorizationUrl);

      expect(url.origin + url.pathname).toBe('https://zoom.us/oauth/authorize');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe(CONFIGURED.clientId);
      expect(url.searchParams.get('redirect_uri')).toBe(CONFIGURED.redirectUri);
    });

    /*
     * THE CLIENT SECRET NEVER TRAVELS. It authenticates Atlas at the token
     * endpoint, server to server, and has no business in a URL the
     * customer's browser follows.
     */
    it('NEVER puts the client secret in the authorization url', async () => {
      const { authorizationUrl } = await authorize();
      expect(authorizationUrl).not.toContain(CONFIGURED.clientSecret);
    });

    it('binds the state to the academy, organization and initiating user', async () => {
      await authorize();
      expect(stateCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            academyId: ACADEMY_ID,
            organizationId: ORG_ID,
            userId: USER_ID,
          }),
        }),
      );
    });

    /*
     * ONLY THE DIGEST IS PERSISTED. A database reader must not be able to
     * resume somebody else's authorization, which is the same reason
     * `live_session_join_grants` stores a token hash.
     */
    it('stores only a HASH of the state, never the state itself', async () => {
      const { authorizationUrl } = await authorize();
      const state = new URL(authorizationUrl).searchParams.get('state')!;
      const stored = stateCreate.mock.calls[0][0].data.stateHash;

      expect(stored).not.toBe(state);
      expect(stored).toBe(createHash('sha256').update(state).digest('hex'));
    });

    it('produces an unguessable, different state every time', async () => {
      const a = new URL((await authorize()).authorizationUrl).searchParams.get('state')!;
      const b = new URL((await authorize()).authorizationUrl).searchParams.get('state')!;

      expect(a).not.toBe(b);
      // 32 random bytes, base64url — nothing derived from the tenant.
      expect(a.length).toBeGreaterThanOrEqual(40);
      expect(a).not.toContain(ACADEMY_ID);
      expect(a).not.toContain(USER_ID);
    });
  });

  describe('consumeState', () => {
    it('resolves the academy the state was minted for', async () => {
      const resolved = await service.consumeState('some-state', USER_ID);
      expect(resolved).toEqual({ academyId: ACADEMY_ID, organizationId: ORG_ID });
    });

    /* Matched on the DIGEST, so the stored value is never compared in the clear. */
    it('looks the state up by its hash', async () => {
      await service.consumeState('some-state', USER_ID);
      expect(stateUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            stateHash: createHash('sha256').update('some-state').digest('hex'),
          }),
        }),
      );
    });

    /*
     * THE FOUR CONDITIONS THAT MAKE THIS SAFE, all in one predicate the
     * DATABASE evaluates: right user, unconsumed, unexpired, and matching.
     */
    it('requires the state to be unconsumed, unexpired and owned by this user', async () => {
      await service.consumeState('some-state', USER_ID);
      const where = stateUpdateMany.mock.calls[0][0].where;

      expect(where.userId).toBe(USER_ID);
      expect(where.consumedAt).toBeNull();
      expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
    });

    /* REPLAY. A captured callback re-submitted matches nothing. */
    it('REJECTS a state that was already consumed', async () => {
      stateUpdateMany.mockResolvedValue({ count: 0 });
      expect(await service.consumeState('used-state', USER_ID)).toBeNull();
    });

    it('REJECTS an expired state', async () => {
      stateUpdateMany.mockResolvedValue({ count: 0 });
      expect(await service.consumeState('old-state', USER_ID)).toBeNull();
    });

    /*
     * CSRF / SESSION FIXATION. An authorization begun by the owner cannot
     * be finished by anyone else who obtains the callback URL — the
     * predicate includes the user it was minted for.
     */
    it('REJECTS a state belonging to a DIFFERENT user', async () => {
      stateUpdateMany.mockResolvedValue({ count: 0 });
      expect(await service.consumeState('someone-elses-state', 'attacker')).toBeNull();
    });

    it('does not resolve an academy when the state was refused', async () => {
      stateUpdateMany.mockResolvedValue({ count: 0 });
      await service.consumeState('bad', USER_ID);
      expect(stateFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('getAccessTokenForAcademy', () => {
    const connected = (over: Record<string, unknown> = {}) => ({
      id: 'conn-1',
      status: 'connected',
      encryptedCredentials: 'enc({"accessToken":"at-1","refreshToken":"rt-1"})',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      refreshTokenExpiresAt: new Date(Date.now() + 80 * 24 * 60 * 60 * 1000),
      ...over,
    });

    it('returns the stored access token while it is still valid', async () => {
      connFindUnique.mockResolvedValue(connected());
      await expect(service.getAccessTokenForAcademy(ACADEMY_ID, ORG_ID)).resolves.toBe(
        'at-1',
      );
    });

    it('refuses when the academy has no connection', async () => {
      connFindUnique.mockResolvedValue(null);
      await expect(
        service.getAccessTokenForAcademy(ACADEMY_ID, ORG_ID),
      ).rejects.toMatchObject({
        response: { messageKey: 'errors.liveSessions.providerNotConnected' },
      });
    });

    it('refuses when the connection is not in a connected state', async () => {
      connFindUnique.mockResolvedValue(connected({ status: 'reconnect_required' }));
      await expect(
        service.getAccessTokenForAcademy(ACADEMY_ID, ORG_ID),
      ).rejects.toThrow();
    });

    /*
     * A refresh token past its own 90-day life cannot succeed. Saying so
     * without a pointless round trip — and, crucially, moving the
     * connection to a state the UI can explain rather than failing
     * anonymously every time a class tries to start.
     */
    it('moves to reconnect_required when the REFRESH token itself has expired', async () => {
      connFindUnique.mockResolvedValue(
        connected({
          accessTokenExpiresAt: new Date(Date.now() - 1000),
          refreshTokenExpiresAt: new Date(Date.now() - 1000),
        }),
      );

      await expect(
        service.getAccessTokenForAcademy(ACADEMY_ID, ORG_ID),
      ).rejects.toMatchObject({
        response: { messageKey: 'errors.liveSessions.providerReconnectRequired' },
      });

      expect(connUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'reconnect_required' }),
        }),
      );
    });

    /*
     * THE CONNECTION IS NEVER DELETED. An academy's sessions, attendance
     * and recordings survive a dead authorization — the fix is a
     * re-authorization, not a re-setup.
     */
    it('does NOT delete the connection when authorization dies', async () => {
      connFindUnique.mockResolvedValue(
        connected({
          accessTokenExpiresAt: new Date(Date.now() - 1000),
          refreshTokenExpiresAt: new Date(Date.now() - 1000),
        }),
      );
      await service.getAccessTokenForAcademy(ACADEMY_ID, ORG_ID).catch(() => undefined);

      const data = connUpdateMany.mock.calls[0][0].data;
      expect(data.encryptedCredentials).toBeUndefined();
      expect(data.status).toBe('reconnect_required');
    });
  });

  describe('token handling', () => {
    it('encrypts the token set rather than storing it in the clear', () => {
      const cipher = service.encryptTokens({
        accessToken: 'at-secret',
        refreshToken: 'rt-secret',
      });
      expect(encrypt).toHaveBeenCalled();
      // The value handed to the encryptor is the only place the tokens
      // appear; what is stored is its output.
      expect(cipher).toBe('enc({"accessToken":"at-secret","refreshToken":"rt-secret"})');
    });

    it('round-trips a token set through the existing encryption seam', () => {
      const tokens = { accessToken: 'a', refreshToken: 'b' };
      expect(service.decryptTokens(service.encryptTokens(tokens))).toEqual(tokens);
    });

    /*
     * THE ROTATION GUARD'S KEY. A digest, never the token — the guard must
     * not become the place a credential sits in a WHERE clause.
     */
    it('fingerprints a refresh token without revealing it', () => {
      const fp = service.fingerprint('rt-secret');
      expect(fp).not.toContain('rt-secret');
      expect(fp).toBe(createHash('sha256').update('rt-secret').digest('hex'));
    });

    it('produces a stable fingerprint for the same token and a different one otherwise', () => {
      expect(service.fingerprint('a')).toBe(service.fingerprint('a'));
      expect(service.fingerprint('a')).not.toBe(service.fingerprint('b'));
    });
  });

  describe('markReconnectRequired', () => {
    it('records a provider-agnostic reason, never a Zoom payload', async () => {
      await service.markReconnectRequired(ACADEMY_ID, ORG_ID, 'refresh_failed');
      const data = connUpdateMany.mock.calls[0][0].data;

      expect(data.status).toBe('reconnect_required');
      expect(data.lastCheckResult).toEqual({ healthy: false, reason: 'refresh_failed' });
    });
  });
});
