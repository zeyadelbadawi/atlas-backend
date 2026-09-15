/**
 * ZoomOAuthService — Atlas's own Zoom application, authorized once per
 * academy by that academy's own Zoom admin.
 *
 * WHAT CHANGED, AND WHY IT HAD TO. Atlas previously asked each academy to
 * create their own Zoom Server-to-Server app and paste an account id,
 * client id and client secret. That works technically and is unacceptable
 * as a product: it turns every customer into a Zoom developer, and it
 * makes Atlas the custodian of a credential that can do far more than
 * Atlas needs. Atlas now owns the application; the customer grants it an
 * authorization, and an authorization is all that is stored.
 *
 * THE TOKEN SET IS THE SECRET NOW. `encrypted_credentials` holds an
 * access token and a refresh token instead of a client secret — the same
 * `CredentialEncryptionService` envelope, the same single encryption
 * seam, different contents. Nothing here ever returns either token to a
 * caller outside this service, and no token, code, or state value is ever
 * logged.
 *
 * REFRESH TOKENS ROTATE, AND THAT IS THE DANGEROUS PART. Zoom issues a
 * NEW refresh token on every refresh and invalidates the old one. Two
 * concurrent refreshes therefore race: both present the same valid token,
 * one wins, and if the loser's response is written second it overwrites
 * the winner's token with one Zoom has already invalidated — silently
 * breaking the connection until somebody re-authorizes. The write is
 * guarded by a CONDITIONAL update keyed on the refresh token that was
 * actually used (see {@link refreshAccessToken}), so a stale rotation
 * cannot clobber a newer one. The database decides, not application code.
 *
 * FAILURE IS A STATE, NOT A DELETION. An expired or revoked authorization
 * moves the connection to `reconnect_required` and keeps the row: the
 * academy's sessions, attendance and recordings stay intact, and an owner
 * re-authorizes. Deleting the connection on a refresh failure would throw
 * away history to report a recoverable problem.
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CredentialEncryptionService } from '../../billing/utils/credential-encryption.util';
import type { ZoomConfig } from '../../config/configuration';

const ZOOM_AUTHORIZE_URL = 'https://zoom.us/oauth/authorize';
const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';
const ZOOM_API_BASE = 'https://api.zoom.us/v2';

/**
 * How long an authorization attempt may stay open.
 *
 * Long enough for a real person to sign in to Zoom and read a consent
 * screen, short enough that an abandoned attempt cannot be completed by
 * somebody else much later.
 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Refresh this long before the access token actually expires.
 *
 * Refreshing exactly at expiry loses every request already in flight and
 * anything delayed by clock skew between Atlas and Zoom.
 */
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Zoom documents a 90-day refresh-token lifetime. Tracked so expiry is visible before it bites. */
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The scopes Atlas requests.
 *
 * Granular rather than broad: each maps to one capability Live Sessions
 * genuinely uses, so a customer's consent screen is an honest description
 * of what Atlas will do. `report:read:admin` is the only admin-tier scope
 * and is what makes the app admin-managed — it is also the one that makes
 * authoritative post-session attendance possible at all.
 */
export const ZOOM_OAUTH_SCOPES: readonly string[] = [
  'meeting:write:meeting:admin',
  'meeting:read:meeting:admin',
  'report:read:admin',
  'cloud_recording:read:list_recording_files:admin',
  'user:read:user:admin',
  'user:read:token',
];

/** The decrypted token set. Exists only inside this service's stack frames. */
export interface ZoomTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string;
}

function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

@Injectable()
export class ZoomOAuthService {
  private readonly logger = new Logger(ZoomOAuthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
  ) {}

  private get zoom(): ZoomConfig {
    return this.configService.get<ZoomConfig>('zoom') ?? {};
  }

  /**
   * Whether Atlas itself is configured to run an authorization at all.
   *
   * Reported rather than assumed: with no Zoom application registered,
   * the connection screen must say "not configured" instead of sending a
   * customer to a Zoom page that will reject them.
   */
  isConfigured(): boolean {
    const { clientId, clientSecret, redirectUri } = this.zoom;
    return Boolean(clientId && clientSecret && redirectUri);
  }

  /**
   * Starts an authorization: mints single-use state and returns the URL
   * the owner's browser should visit.
   *
   * The academy and the initiating user are recorded SERVER-SIDE against
   * the state. Nothing about which academy is being connected travels in
   * a form the browser can alter — the callback re-reads both from the
   * stored row, so a tampered `state` simply matches nothing.
   */
  async createAuthorization(args: {
    readonly academyId: string;
    readonly organizationId: string;
    readonly userId: string;
  }): Promise<{ authorizationUrl: string; expiresAt: Date }> {
    const { clientId, redirectUri } = this.zoom;
    if (!this.isConfigured() || !clientId || !redirectUri) {
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.providerNotConfigured',
      });
    }

    // 32 bytes of CSPRNG. The state's only job is to be unguessable and
    // spendable once; it carries no data, so there is nothing in it to
    // leak or to tamper with.
    const state = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);

    await this.tenancyContextService.runInUserContext(args.userId, (tx) =>
      tx.liveProviderOAuthState.create({
        data: {
          // Only the digest is persisted — a database reader cannot
          // resume somebody else's authorization.
          stateHash: hashState(state),
          academyId: args.academyId,
          organizationId: args.organizationId,
          userId: args.userId,
          expiresAt,
        },
      }),
    );

    const url = new URL(ZOOM_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);

    return { authorizationUrl: url.toString(), expiresAt };
  }

  /**
   * Spends the state exactly once.
   *
   * The conditional UPDATE is the whole mechanism: it matches only a
   * state that is unconsumed, unexpired AND belongs to this user. Two
   * simultaneous callbacks with the same state produce one success and
   * one refusal, decided by the database rather than by a read-then-write
   * that races with itself. A replayed callback matches nothing.
   */
  async consumeState(
    state: string,
    userId: string,
  ): Promise<{ academyId: string; organizationId: string } | null> {
    const stateHash = hashState(state);
    const now = new Date();

    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const updated = await tx.liveProviderOAuthState.updateMany({
        where: { stateHash, userId, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (updated.count !== 1) return null;

      const row = await tx.liveProviderOAuthState.findUnique({
        where: { stateHash },
        select: { academyId: true, organizationId: true },
      });
      return row ?? null;
    });
  }

  /**
   * Exchanges the authorization code for a token set and identifies the
   * connected Zoom account.
   *
   * The code is single-use at Zoom's end too, and is never logged.
   */
  async exchangeCode(code: string): Promise<{
    tokens: ZoomTokenSet;
    accessTokenExpiresAt: Date;
    refreshTokenExpiresAt: Date;
    scopes: readonly string[];
    accountId: string;
    userId: string;
    userEmail?: string;
  }> {
    const { redirectUri } = this.zoom;
    if (!redirectUri) {
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.providerNotConfigured',
      });
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    const token = await this.postToken(body);

    // The account this authorization actually belongs to is read FROM
    // ZOOM, never from anything the browser supplied. This is what binds
    // the connection to the right customer account.
    const identity = await this.fetchAuthorizedUser(token.access_token);

    const now = Date.now();
    return {
      tokens: { accessToken: token.access_token, refreshToken: token.refresh_token },
      accessTokenExpiresAt: new Date(now + token.expires_in * 1000),
      refreshTokenExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
      scopes: token.scope ? token.scope.split(/\s+/).filter(Boolean) : [],
      accountId: identity.accountId,
      userId: identity.userId,
      userEmail: identity.userEmail,
    };
  }

  /**
   * Returns a usable access token for an academy, refreshing first if the
   * stored one is close to expiry.
   *
   * THE ONLY WAY the rest of Live Sessions obtains Zoom authorization.
   * Callers never touch the token set, never decrypt anything, and never
   * decide whether a refresh is due.
   */
  async getAccessTokenForAcademy(
    academyId: string,
    organizationId: string,
  ): Promise<string> {
    const connection = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        tx.academyLiveProviderConnection.findUnique({
          where: { academyId },
          select: {
            id: true,
            status: true,
            encryptedCredentials: true,
            accessTokenExpiresAt: true,
            refreshTokenExpiresAt: true,
          },
        }),
    );

    if (!connection?.encryptedCredentials || connection.status !== 'connected') {
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.providerNotConnected',
      });
    }

    const tokens = this.decryptTokens(connection.encryptedCredentials);

    const expiresAt = connection.accessTokenExpiresAt?.getTime() ?? 0;
    if (expiresAt - ACCESS_TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return tokens.accessToken;
    }

    // A refresh token that is already past its own expiry cannot succeed;
    // saying so without a pointless round trip to Zoom.
    if (
      connection.refreshTokenExpiresAt &&
      connection.refreshTokenExpiresAt.getTime() <= Date.now()
    ) {
      await this.markReconnectRequired(
        academyId,
        organizationId,
        'refresh_token_expired',
      );
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.providerReconnectRequired',
      });
    }

    const refreshed = await this.refreshAccessToken(
      academyId,
      organizationId,
      tokens.refreshToken,
    );
    return refreshed;
  }

  /**
   * Refreshes, and writes the rotated token set back safely.
   *
   * @returns the new access token.
   */
  private async refreshAccessToken(
    academyId: string,
    organizationId: string,
    currentRefreshToken: string,
  ): Promise<string> {
    let token: ZoomTokenResponse;
    try {
      token = await this.postToken(
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: currentRefreshToken,
        }),
      );
    } catch {
      // A failed refresh is the normal end of an authorization's life:
      // 90 days elapsed, the customer deauthorized, or the authorizing
      // Zoom user is gone. None of those are Atlas errors, and none of
      // them justify destroying the academy's session history.
      await this.markReconnectRequired(academyId, organizationId, 'refresh_failed');
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.providerReconnectRequired',
      });
    }

    const now = Date.now();
    const encrypted = this.encryptTokens({
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
    });

    /*
      THE ROTATION GUARD.

      Zoom invalidates the old refresh token the moment it issues a new
      one, so two concurrent refreshes leave one rotation valid and one
      already dead. Matching on the ciphertext that was READ before the
      call means a refresh whose starting point has since been replaced
      writes nothing — the newer rotation stands. Without this, the loser
      of the race would overwrite a live token with a dead one and break
      the connection until somebody re-authorized.
    */
    const currentFingerprint = this.fingerprint(currentRefreshToken);

    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const result = await tx.academyLiveProviderConnection.updateMany({
        where: { academyId, refreshTokenFingerprint: currentFingerprint },
        data: {
          encryptedCredentials: encrypted,
          accessTokenExpiresAt: new Date(now + token.expires_in * 1000),
          refreshTokenExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
          refreshTokenFingerprint: this.fingerprint(token.refresh_token),
          status: 'connected',
        },
      });

      if (result.count !== 1) {
        // Another refresh already rotated this connection. Its token is
        // the live one; ours is spent. Nothing to write, nothing wrong.
        this.logger.log(
          { academyId },
          'Concurrent token rotation detected — keeping the newer token set.',
        );
      }
    });

    return token.access_token;
  }

  /** Moves the connection to a state only re-authorization can clear. */
  async markReconnectRequired(
    academyId: string,
    organizationId: string,
    reason: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      tx.academyLiveProviderConnection.updateMany({
        where: { academyId },
        data: {
          status: 'reconnect_required',
          // Provider-agnostic summary only — never a Zoom error payload.
          lastCheckResult: { healthy: false, reason },
          lastCheckedAt: new Date(),
        },
      }),
    );
  }

  encryptTokens(tokens: ZoomTokenSet): string {
    return this.credentialEncryptionService.encrypt(JSON.stringify(tokens));
  }

  decryptTokens(ciphertext: string): ZoomTokenSet {
    return JSON.parse(
      this.credentialEncryptionService.decrypt(ciphertext),
    ) as ZoomTokenSet;
  }

  /**
   * A stable, non-reversible marker for one refresh token.
   *
   * Used only to detect "has this connection already rotated past the
   * token I started with?". A digest rather than the token, so the guard
   * itself never becomes a place a credential sits in a query.
   */
  fingerprint(refreshToken: string): string {
    return createHash('sha256').update(refreshToken).digest('hex');
  }

  /** Exchanges/refreshes at Zoom's token endpoint. Never logs the body. */
  private async postToken(body: URLSearchParams): Promise<ZoomTokenResponse> {
    const { clientId, clientSecret } = this.zoom;
    if (!clientId || !clientSecret) {
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.providerNotConfigured',
      });
    }

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch(ZOOM_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      // STATUS ONLY. Zoom's error body echoes request context and can
      // contain the code or token that failed; this line must never
      // become the place a credential reaches the log.
      throw new Error(`Zoom token request failed with status ${response.status}`);
    }

    const parsed = (await response.json()) as Partial<ZoomTokenResponse>;
    if (!parsed.access_token || !parsed.refresh_token || !parsed.expires_in) {
      throw new Error('Zoom token response was incomplete');
    }
    return parsed as ZoomTokenResponse;
  }

  /** Reads the authorizing user and, crucially, their Zoom account id. */
  private async fetchAuthorizedUser(accessToken: string): Promise<{
    accountId: string;
    userId: string;
    userEmail?: string;
  }> {
    const response = await fetch(`${ZOOM_API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Zoom user lookup failed with status ${response.status}`);
    }
    const user = (await response.json()) as {
      id?: string;
      account_id?: string;
      email?: string;
    };
    if (!user.account_id || !user.id) {
      throw new Error('Zoom user response did not identify an account');
    }
    return { accountId: user.account_id, userId: user.id, userEmail: user.email };
  }
}

interface ZoomTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}
