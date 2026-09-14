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
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AcademyLiveProviderConnection } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CredentialEncryptionService } from '../../billing/utils/credential-encryption.util';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { ZoomProvider } from '../providers/zoom.provider';
import type { LiveProviderCredentials } from '../providers/live-provider.interface';

export interface ConnectZoomInput {
  readonly accountId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly sdkKey?: string;
  readonly sdkSecret?: string;
  readonly webhookSecretToken?: string;
}

@Injectable()
export class LiveProviderConnectionService {
  private readonly logger = new Logger(LiveProviderConnectionService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly credentialEncryptionService: CredentialEncryptionService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly usersRepository: UsersRepository,
    private readonly zoomProvider: ZoomProvider,
  ) {}

  /**
   * Connects (or reconnects) an academy's Zoom account.
   *
   * VERIFIED BEFORE STORED. The credentials are exercised against Zoom
   * first; a set that does not work is rejected rather than saved in a
   * broken state that would only surface when a class was due to start.
   * That also means a genuine Zoom outage is reported as a failed
   * connection attempt rather than a silently unhealthy connection.
   */
  async connect(
    academyId: string,
    organizationId: string,
    actorUserId: string,
    input: ConnectZoomInput,
  ): Promise<AcademyLiveProviderConnection> {
    const credentials: LiveProviderCredentials = {
      accountId: input.accountId.trim(),
      clientId: input.clientId.trim(),
      clientSecret: input.clientSecret.trim(),
      sdkKey: input.sdkKey?.trim() || undefined,
      sdkSecret: input.sdkSecret?.trim() || undefined,
      webhookSecretToken: input.webhookSecretToken?.trim() || undefined,
    };

    const health = await this.zoomProvider.checkHealth(credentials);
    if (!health.healthy) {
      // A provider-agnostic reason only. Zoom's own error text can echo
      // request context and must not reach the customer or the log.
      throw new BadRequestException({
        messageKey: 'errors.liveSessions.providerConnectionFailed',
        code: 'PROVIDER_CONNECTION_FAILED',
      });
    }

    const encrypted = this.credentialEncryptionService.encrypt(
      JSON.stringify(credentials),
    );

    const now = new Date();

    const connection = await this.tenancyContextService.runInTenantAndUserContext(
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
            externalAccountId: credentials.accountId,
            connectedByUserId: actorUserId,
            connectedAt: now,
            lastCheckedAt: now,
            lastCheckResult: { healthy: true },
          },
          update: {
            status: 'connected',
            encryptedCredentials: encrypted,
            externalAccountId: credentials.accountId,
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
          // The account id is not a secret; nothing else is recorded.
          context: { academyId, providerKey: 'zoom' },
        });

        return saved;
      },
    );

    return connection;
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
            encryptedCredentials: null,
            externalAccountId: null,
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

    const credentials = await this.decryptCredentials(connection);
    const health = await this.zoomProvider.checkHealth(credentials);

    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      tx.academyLiveProviderConnection.update({
        where: { academyId },
        data: {
          // `expired` rather than `error` when credentials stop working:
          // the fix is reconnecting, and the UI says exactly that.
          status: health.healthy ? 'connected' : 'expired',
          lastCheckedAt: new Date(),
          lastCheckResult: { healthy: health.healthy },
        },
      }),
    );

    return { healthy: health.healthy };
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
  async decryptCredentials(
    connection: AcademyLiveProviderConnection,
  ): Promise<LiveProviderCredentials> {
    if (!connection.encryptedCredentials) {
      throw new ForbiddenException({
        messageKey: 'errors.liveSessions.providerNotConnected',
      });
    }
    try {
      return JSON.parse(
        this.credentialEncryptionService.decrypt(connection.encryptedCredentials),
      ) as LiveProviderCredentials;
    } catch {
      // A tampered or key-rotated ciphertext. Reported as a connection
      // problem the academy can fix by reconnecting, never as a 500 with
      // crypto internals attached.
      this.logger.error(
        { academyId: connection.academyId },
        'Stored provider credentials could not be decrypted.',
      );
      throw new ForbiddenException({
        messageKey: 'errors.liveSessions.providerNotConnected',
      });
    }
  }
}
