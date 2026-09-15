/**
 * LiveProviderConnectionService — an academy's Zoom connection.
 *
 * WHY SERVER-TO-SERVER OAUTH AND NOT A REDIRECT/PKCE FLOW. This is a
 * deliberate product decision, and it is the reason there is no
 * authorization-code callback in this feature.
 *
 * Zoom offers two models. A *General (user) OAuth* app uses a redirect,
 * a callback and PKCE, and binds the connection to ONE PERSON'S Zoom
 * login — when that instructor leaves the academy, every meeting created
 * under their grant goes with them, and refresh tokens expire against a
 * human's session. A *Server-to-Server OAuth* app is owned by the Zoom
 * ACCOUNT, mints short-lived tokens from account credentials, and
 * survives staff turnover.
 *
 * Live Sessions are academy infrastructure, not one teacher's personal
 * meetings, so the account-owned model is the correct one — and it is the
 * model `ZoomProvider` was already built against. Implementing a redirect
 * flow would have meant rebuilding that adapter to solve a problem the
 * academy does not have. PKCE is not applicable here: there is no user
 * agent in the exchange to protect, because there is no redirect.
 *
 * WHAT "CONNECTING" THEREFORE IS: an authorized academy role submits the
 * credentials from their own Zoom app, Atlas verifies them against Zoom
 * before storing anything, and stores them encrypted. Nothing is ever
 * returned to a browser afterwards.
 *
 * CREDENTIALS NEVER LEAVE THE SERVER. They are encrypted at rest with the
 * existing `CredentialEncryptionService` (AES-256-GCM) — the same single
 * seam `organization_gateway_credentials` uses — decrypted only inside a
 * provider call, and never placed in a DTO, a log line, or an exception
 * message.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AcademyLiveProviderConnection } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { ZoomProvider } from '../providers/zoom.provider';
import { ZoomOAuthService } from './zoom-oauth.service';

@Injectable()
export class LiveProviderConnectionService {
  private readonly logger = new Logger(LiveProviderConnectionService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly usersRepository: UsersRepository,
    private readonly zoomProvider: ZoomProvider,
    private readonly zoomOAuthService: ZoomOAuthService,
  ) {}

  /**
   * Completes an authorization: exchanges the code and stores the token
   * set against the academy the STATE named.
   *
   * WHAT THIS REPLACED. `connect()` used to accept an academy's own Zoom
   * account id, client id and client secret from a form. Customers no
   * longer create Zoom apps at all, so nothing is typed and nothing about
   * Atlas's application is customer-specific — only the authorization is.
   *
   * THE ACADEMY COMES FROM THE STATE, NOT THE BROWSER. Both ids are
   * resolved server-side from the stored OAuth state before this runs, so
   * a returning callback cannot redirect an authorization onto a
   * different tenant.
   */
  async completeOAuthConnection(args: {
    readonly academyId: string;
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly code: string;
  }): Promise<AcademyLiveProviderConnection> {
    const { academyId, organizationId, actorUserId, code } = args;

    const exchanged = await this.zoomOAuthService.exchangeCode(code);

    /*
      ONE ZOOM ACCOUNT, ONE ACADEMY.

      Webhooks are attributed by the verified `account_id`, so two
      academies sharing one Zoom account would make that mapping
      ambiguous and could route an event into the wrong tenant. A partial
      unique index enforces this in the database; checking here as well
      turns a raw constraint violation into an answer the UI can explain.

      Read under platform-owner context because the conflicting row may
      belong to a DIFFERENT organization — which is precisely the case
      worth catching.
    */
    const conflicting = await this.findLiveConnectionForAccount(exchanged.accountId);
    if (conflicting && conflicting.academyId !== academyId) {
      // Deliberately opaque to the browser: the caller turns this into a
      // generic "already in use" result and never names the other tenant.
      throw new Error('ACCOUNT_ALREADY_BOUND');
    }

    const encrypted = this.zoomOAuthService.encryptTokens(exchanged.tokens);
    const now = new Date();

    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actorUserId,
      async (tx) => {
        const saved = await tx.academyLiveProviderConnection.upsert({
          where: { academyId },
          create: {
            academyId,
            providerKey: 'zoom',
            status: 'connected',
            encryptedCredentials: encrypted,
            externalAccountId: exchanged.accountId,
            externalUserId: exchanged.userId,
            externalUserEmail: exchanged.userEmail ?? null,
            accessTokenExpiresAt: exchanged.accessTokenExpiresAt,
            refreshTokenExpiresAt: exchanged.refreshTokenExpiresAt,
            refreshTokenFingerprint: this.zoomOAuthService.fingerprint(
              exchanged.tokens.refreshToken,
            ),
            grantedScopes: [...exchanged.scopes],
            connectedByUserId: actorUserId,
            connectedAt: now,
            lastCheckedAt: now,
            lastCheckResult: { healthy: true },
          },
          update: {
            status: 'connected',
            encryptedCredentials: encrypted,
            externalAccountId: exchanged.accountId,
            externalUserId: exchanged.userId,
            externalUserEmail: exchanged.userEmail ?? null,
            accessTokenExpiresAt: exchanged.accessTokenExpiresAt,
            refreshTokenExpiresAt: exchanged.refreshTokenExpiresAt,
            refreshTokenFingerprint: this.zoomOAuthService.fingerprint(
              exchanged.tokens.refreshToken,
            ),
            grantedScopes: [...exchanged.scopes],
            connectedByUserId: actorUserId,
            connectedAt: now,
            lastCheckedAt: now,
            lastCheckResult: { healthy: true },
          },
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId,
          organizationId,
          action: 'live_provider.connected',
          targetType: 'academy_live_provider_connection',
          targetId: saved.id,
          // Non-secret identifiers only. No token, no scope secret, no
          // authorization code.
          context: {
            academyId,
            providerKey: 'zoom',
            externalAccountId: exchanged.accountId,
          },
        });

        return saved;
      },
    );
  }

  /**
   * Finds a LIVE connection already bound to a Zoom account, across every
   * tenant.
   *
   * Cross-tenant and read-only, using the same platform-owner mechanism
   * webhook attribution uses. `not_connected` rows are ignored on
   * purpose: a disconnected academy keeps its account id for display, and
   * must not block the same customer from binding it again.
   */
  private async findLiveConnectionForAccount(
    externalAccountId: string,
  ): Promise<{ academyId: string } | null> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) return null;

    return this.tenancyContextService.runInUserContext(platformOwner.id, async (tx) => {
      const row = await tx.academyLiveProviderConnection.findFirst({
        where: {
          externalAccountId,
          status: { in: ['connected', 'reconnect_required', 'expired'] },
        },
        select: { academyId: true },
      });
      return row ?? null;
    });
  }

  /**
   * Disconnects, and DESTROYS the stored credentials.
   *
   * The row is kept (so the UI can say "disconnected" rather than
   * forgetting the academy ever had a connection) but
   * `encrypted_credentials` is nulled: a disconnect that left decryptable
   * secrets behind would make "disconnect" a lie.
   *
   * Existing sessions are deliberately NOT deleted. They become
   * unjoinable — `LiveSessionAccessService` already refuses when the
   * provider is not connected — and become joinable again on reconnect.
   */
  async disconnect(
    academyId: string,
    organizationId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actorUserId,
      async (tx) => {
        const existing = await tx.academyLiveProviderConnection.findUnique({
          where: { academyId },
          select: { id: true },
        });
        if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

        await tx.academyLiveProviderConnection.update({
          where: { academyId },
          data: {
            status: 'not_connected',
            // EVERY piece of token material goes. A disconnect that left
            // a decryptable token behind would make "disconnect" a lie.
            encryptedCredentials: null,
            refreshTokenFingerprint: null,
            accessTokenExpiresAt: null,
            refreshTokenExpiresAt: null,
            grantedScopes: [],
            externalUserId: null,
            externalUserEmail: null,
            // The account id is kept: the screen still says WHICH Zoom
            // account was attached, and the partial unique index ignores
            // disconnected rows so the same customer can rebind.
            connectedAt: null,
            lastCheckResult: undefined,
          },
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId,
          organizationId,
          action: 'live_provider.disconnected',
          targetType: 'academy_live_provider_connection',
          targetId: existing.id,
          context: { academyId, providerKey: 'zoom' },
        });
      },
    );
  }

  /**
   * Re-checks a stored connection against the provider and records the
   * result, so the UI can distinguish "connected" from "we last spoke to
   * Zoom successfully three weeks ago".
   */
  async checkHealth(
    academyId: string,
    organizationId: string,
  ): Promise<{ healthy: boolean }> {
    const connection = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => tx.academyLiveProviderConnection.findUnique({ where: { academyId } }),
    );

    if (!connection?.encryptedCredentials) {
      return { healthy: false };
    }

    let healthy = false;
    try {
      // Goes through the OAuth service so the check also exercises the
      // REFRESH path — a connection whose access token has expired but
      // whose refresh still works is genuinely healthy, and reporting it
      // as broken would send an owner to re-authorize for nothing.
      const accessToken = await this.zoomOAuthService.getAccessTokenForAcademy(
        academyId,
        organizationId,
      );
      const health = await this.zoomProvider.checkHealth(accessToken);
      healthy = health.healthy;
    } catch {
      // `getAccessTokenForAcademy` has already moved the connection to
      // `reconnect_required` if the authorization is genuinely dead, so
      // nothing further is written here — overwriting that with a generic
      // `expired` would lose the more precise state.
      return { healthy: false };
    }

    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      tx.academyLiveProviderConnection.update({
        where: { academyId },
        data: {
          status: healthy ? 'connected' : 'expired',
          lastCheckedAt: new Date(),
          lastCheckResult: { healthy },
        },
      }),
    );

    return { healthy };
  }

  /**
   * Resolves which academy a provider meeting belongs to.
   *
   * Used by the webhook to decide WHOSE secret to verify a signature
   * with. Runs outside tenant context by necessity — a webhook has no
   * tenant context yet, and the whole point is to discover it — which is
   * why the lookup is keyed on a provider identifier Atlas itself stored,
   * never on a tenant id supplied by the caller.
   */
  async findConnectionForMeeting(
    providerMeetingId: string,
  ): Promise<AcademyLiveProviderConnection | null> {
    /*
      RUN AS THE PLATFORM OWNER, because this read is genuinely
      cross-tenant and system-initiated.

      `live_sessions` is RLS-protected with FORCE, so without a context
      this returned nothing and every correctly-signed webhook was
      refused — caught by an integration test, not by reading the code.
      RLS was right; the query needed a context it did not have.

      This uses the same mechanism the subscription sweep already uses
      (`is_platform_owner` + `runInUserContext`), and it is SELECT-only:
      once the tenant is known, every subsequent write happens inside that
      tenant's own context. Nothing about ordinary request isolation
      changes.
    */
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      // Without a platform owner there is no context in which this read is
      // permitted. Failing closed means unattributable webhooks, which is
      // the safe direction — never a fallback that bypasses RLS.
      this.logger.error(
        'No platform owner exists — provider events cannot be attributed.',
      );
      return null;
    }

    return this.tenancyContextService.runInUserContext(platformOwner.id, async (tx) => {
      const session = await tx.liveSession.findFirst({
        where: { providerMeetingId },
        select: { academyId: true },
      });
      if (!session) return null;

      return tx.academyLiveProviderConnection.findUnique({
        where: { academyId: session.academyId },
      });
    });
  }

  /**
   * Resolves the Atlas session a provider meeting belongs to, with the
   * tenancy the worker needs to act on it.
   *
   * Shares the platform-owner context with `findConnectionForMeeting` for
   * the same reason and with the same limits: cross-tenant, SELECT-only,
   * system-initiated. The worker uses the organization id this returns to
   * run every subsequent write inside that tenant's own context.
   */
  async findSessionForMeeting(providerMeetingId: string): Promise<{
    id: string;
    academyId: string;
    organizationId: string;
    status: string;
    recordingEnabled: boolean;
  } | null> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.error(
        'No platform owner exists — provider events cannot be attributed.',
      );
      return null;
    }

    return this.tenancyContextService.runInUserContext(platformOwner.id, async (tx) => {
      const session = await tx.liveSession.findFirst({
        where: { providerMeetingId },
        select: {
          id: true,
          academyId: true,
          status: true,
          recordingEnabled: true,
          academy: { select: { organizationId: true } },
        },
      });
      if (!session) return null;
      return {
        id: session.id,
        academyId: session.academyId,
        organizationId: session.academy.organizationId,
        status: session.status,
        recordingEnabled: session.recordingEnabled,
      };
    });
  }

  /**
   * Maps an academy to its organization.
   *
   * WHY THIS NEEDS ITS OWN PATH. The student-facing endpoints run in USER
   * context so RLS can independently agree the caller may see the session.
   * A student has no policy granting them `academies`, so reading the
   * organization through a nested relation returns null and Prisma fails
   * the whole query — which is exactly how this was found, as a 500 on
   * every student's session page during end-to-end testing.
   *
   * Resolved instead through the SAME platform-owner, SELECT-only
   * mechanism webhook attribution uses. The alternative — letting students
   * read `academies` — would widen RLS for every student on the platform
   * to fix one lookup of a non-sensitive mapping.
   *
   * The caller must already have established that this user may see the
   * session; this answers "which tenant owns it", never "may they".
   */
  async resolveOrganizationForAcademy(academyId: string): Promise<string | null> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.error('No platform owner exists — academy tenancy cannot be resolved.');
      return null;
    }
    return this.tenancyContextService.runInUserContext(platformOwner.id, async (tx) => {
      const academy = await tx.academy.findUnique({
        where: { id: academyId },
        select: { organizationId: true },
      });
      return academy?.organizationId ?? null;
    });
  }

  /**
   * The endpoint-validation handshake arrives BEFORE any meeting exists,
   * so it cannot be attributed by meeting id.
   *
   * Answered only when exactly one connection exists, which is the real
   * shape of a first-time setup. With several connected academies the
   * handshake is ambiguous and is refused rather than guessed — verifying
   * it against an arbitrary academy's secret would be meaningless.
   */
  async findSoleConnectionForValidation(): Promise<AcademyLiveProviderConnection | null> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) return null;

    return this.tenancyContextService.runInUserContext(platformOwner.id, async (tx) => {
      const connections = await tx.academyLiveProviderConnection.findMany({
        where: { encryptedCredentials: { not: null } },
        take: 2,
      });
      return connections.length === 1 ? connections[0] : null;
    });
  }

  /**
   * Decrypts stored credentials for a provider call.
   *
   * The plaintext exists only inside the caller's stack frame. No caller
   * in this codebase returns it, logs it, or puts it in an exception.
   */
}
