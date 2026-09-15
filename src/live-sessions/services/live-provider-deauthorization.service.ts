/**
 * What happens when a customer removes Atlas from their Zoom account.
 *
 * THE AUTHORIZATION IS ALREADY GONE BY THE TIME THIS RUNS. Zoom has
 * invalidated the token set on their side; this notification only tells
 * Atlas about it. So the job here is not to revoke anything at Zoom — it
 * is to stop Atlas holding, and repeatedly retrying, a credential that
 * can no longer work, and to say so honestly in the UI.
 *
 * NO ATLAS ACTOR EXISTS. Every other path that clears a connection is
 * something a person did in Atlas — `disconnect()` takes an
 * `actorUserId` and runs in that user's context. A deauthorization is
 * account-scoped and arrives from outside, so there is nobody to
 * attribute it to. Rather than invent a synthetic user, this follows the
 * convention already used by `SupportCasesService`, `PlatformSettings`
 * and `CommissionService`: the REAL platform owner is the actor for
 * system-initiated writes, and is also the identity whose RLS context
 * makes the tenant discoverable in the first place.
 *
 * TWO CONTEXTS, BECAUSE THE POLICIES GENUINELY DIFFER. Resolving which
 * academy owns a Zoom account has to happen before any tenant is known,
 * and `academy_live_provider_connections_platform_select` is what permits
 * that read. But there is NO platform-owner UPDATE policy on that table —
 * only `..._tenant_update`, keyed on `app.current_organization_id`. So the
 * lookup runs in platform-owner context and the mutation runs in the
 * resolved tenant's context. Nothing is bypassed and no policy was added:
 * the split exists because the existing policies already express exactly
 * this separation.
 *
 * NOTHING SENSITIVE IS LOGGED. No token, no fingerprint, no client
 * secret, no webhook secret, no raw Zoom payload.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { NotificationFanoutService } from '../../notification-events/services/notification-fanout.service';
import type { ExtractedZoomDeauthorization } from '../utils/zoom-deauthorization.util';

/**
 * The connection states a deauthorization can still act on.
 *
 * Deliberately the SAME set as the partial unique index P49b created
 * (`academy_live_provider_connections_account_live_uniq`): those are the
 * rows that hold a live authorization and the rows that can receive a
 * webhook. A row already in `revoked` or `not_connected` holds no token
 * to clear, which is what makes a redelivery a no-op rather than a
 * second, redundant write.
 */
const LIVE_CONNECTION_STATUSES = ['connected', 'reconnect_required', 'expired'] as const;

/**
 * What the handler actually did.
 *
 * For logs and tests ONLY — never for the HTTP response, which is
 * constant. Telling a caller "unknown account" versus "invalidated"
 * would turn the endpoint into an oracle for which Zoom accounts have
 * Atlas installed.
 */
export type DeauthorizationOutcome =
  'invalidated' | 'already_invalidated' | 'unknown_account' | 'stale_ignored';

@Injectable()
export class LiveProviderDeauthorizationService {
  private readonly logger = new Logger(LiveProviderDeauthorizationService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly fanout: NotificationFanoutService,
  ) {}

  async handle(event: ExtractedZoomDeauthorization): Promise<DeauthorizationOutcome> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      /*
        A real internal failure, and the ONLY case that must not answer
        200. Zoom retries a non-2xx, and a retry is exactly right here:
        the notification is valid and Atlas is temporarily unable to
        attribute it. Swallowing it would lose a security-relevant event
        permanently.
      */
      this.logger.error(
        'No platform owner exists — a Zoom deauthorization cannot be attributed.',
      );
      throw new Error('PLATFORM_OWNER_UNAVAILABLE');
    }

    // PHASE 1 — resolve the tenant, in the only context that can see
    // across tenants to do it.
    const matches = await this.tenancyContextService.runInUserContext(
      platformOwner.id,
      (tx) =>
        tx.academyLiveProviderConnection.findMany({
          where: { providerKey: 'zoom', externalAccountId: event.accountId },
          select: {
            id: true,
            academyId: true,
            status: true,
            connectedAt: true,
            academy: { select: { organizationId: true } },
          },
        }),
    );

    if (matches.length === 0) {
      // Never had this account, or the row is long gone. Nothing to do,
      // and nothing to report outward.
      return 'unknown_account';
    }

    /*
      A Zoom account can legitimately appear on more than one row: the
      partial unique index only constrains LIVE rows, precisely so a
      customer who disconnects can rebind the same account (possibly to a
      different academy). Only a live row holds a credential worth
      clearing.
    */
    const live = matches.find((row) =>
      (LIVE_CONNECTION_STATUSES as readonly string[]).includes(row.status),
    );
    if (!live) {
      return 'already_invalidated';
    }

    /*
      THE STALE-NOTIFICATION GUARD.

      A redelivery — or a genuinely delayed notification — can arrive
      AFTER the customer has already reconnected. Clearing the new
      authorization because of an announcement about the old one would
      break a working connection for a customer who did everything right.

      `connectedAt` is stamped when an authorization is stored, so an
      authorization newer than the deauthorization Zoom is describing
      cannot be the one it refers to. This needs no schema change: both
      values already exist.
    */
    if (live.connectedAt && live.connectedAt.getTime() > event.deauthorizedAt.getTime()) {
      this.logger.log(
        { academyId: live.academyId },
        'Ignoring a Zoom deauthorization older than the stored authorization.',
      );
      return 'stale_ignored';
    }

    // PHASE 2 — mutate inside the resolved tenant's own context.
    return this.tenancyContextService.runInTenantContext(
      live.academy.organizationId,
      async (tx) => {
        /*
          CONDITIONAL, AND THE DATABASE DECIDES.

          Matching on both the status set and the exact `connectedAt` read
          in phase 1 means a manual disconnect or a reconnect that landed
          in between matches zero rows and writes nothing — the same
          rotation-guard shape `ZoomOAuthService.refreshAccessToken` uses.
          Two simultaneous deliveries therefore produce one write and one
          no-op, decided by Postgres rather than by a read-then-write race.
        */
        const result = await tx.academyLiveProviderConnection.updateMany({
          where: {
            id: live.id,
            status: { in: [...LIVE_CONNECTION_STATUSES] },
            connectedAt: live.connectedAt,
          },
          data: {
            /*
              `revoked` rather than `not_connected`, because they are
              different facts. `not_connected` is what a person chose in
              Atlas; `revoked` is what happened to Atlas from outside. The
              enum and the UI copy for it already existed — this is the
              first path that can actually produce it.
            */
            status: 'revoked',
            // EVERY piece of token material goes, exactly as `disconnect`
            // does it. A revocation that left a decryptable token behind
            // would be worse than a disconnect that did.
            encryptedCredentials: null,
            refreshTokenFingerprint: null,
            accessTokenExpiresAt: null,
            refreshTokenExpiresAt: null,
            grantedScopes: [],
            externalUserId: null,
            externalUserEmail: null,
            connectedAt: null,
            // The account id is KEPT, matching `disconnect`: the screen
            // still says which Zoom account was attached, and a revoked
            // row is outside the partial unique index so the same
            // customer can rebind.
            lastCheckedAt: new Date(),
            lastCheckResult: { healthy: false, reason: 'app_deauthorized' },
          },
        });

        if (result.count !== 1) {
          // Someone else got there first — a concurrent delivery, or a
          // manual disconnect. Their write stands; ours is redundant.
          return 'already_invalidated';
        }

        await this.auditLogWriterService.write(tx, {
          // The real platform owner, per the established system-actor
          // convention. Not a synthetic user.
          actorUserId: platformOwner.id,
          organizationId: live.academy.organizationId,
          academyId: live.academyId,
          role: 'platform_owner',
          action: 'live_provider.deauthorized',
          targetType: 'academy_live_provider_connection',
          targetId: live.id,
          // Non-secret identifiers only.
          context: {
            academyId: live.academyId,
            providerKey: 'zoom',
            externalAccountId: event.accountId,
            deauthorizedAt: event.deauthorizedAt.toISOString(),
            ...(event.zoomUserId ? { zoomUserId: event.zoomUserId } : {}),
          },
        });

        await this.notifyOrganizationOwners(tx, {
          organizationId: live.academy.organizationId,
          academyId: live.academyId,
          connectionId: live.id,
          deauthorizedAt: event.deauthorizedAt,
        });

        this.logger.warn(
          { academyId: live.academyId },
          'Zoom authorization was removed by the customer — connection revoked.',
        );

        return 'invalidated';
      },
    );
  }

  /**
   * Tells the people who can actually fix it.
   *
   * ORGANIZATION OWNERS ONLY, because reconnecting is owner-exclusive
   * (`LiveProviderOAuthController` gates it on `tenant.addon.view`).
   * Notifying a Manager would be an alert about something they are not
   * permitted to resolve.
   *
   * Uses the EXISTING fan-out; no new notification subsystem. Only the
   * in-app row is written here — `notify` is transaction-safe by design,
   * and no email is sent because this service has no post-commit seam of
   * its own to hang one on.
   */
  private async notifyOrganizationOwners(
    tx: Prisma.TransactionClient,
    args: {
      readonly organizationId: string;
      readonly academyId: string;
      readonly connectionId: string;
      readonly deauthorizedAt: Date;
    },
  ): Promise<void> {
    const owners = await tx.organizationMembership.findMany({
      where: { organizationId: args.organizationId, role: 'owner' },
      select: { userId: true },
    });

    for (const owner of owners) {
      await this.fanout.notify(tx, {
        userId: owner.userId,
        type: 'security',
        priority: 'high',
        titleKey: 'notifications:liveProvider.deauthorized.title',
        messageKey: 'notifications:liveProvider.deauthorized.message',
        actionUrl: '/dashboard/add-ons/live-sessions/connection',
        actionLabelKey: 'notifications:liveProvider.action.reconnect',
        /*
          Keyed on the connection AND the moment Zoom reported, so a
          redelivery of the same event dedupes while a genuine later
          deauthorization (after a reconnect) still notifies.
        */
        dedupeKey: `live_provider.deauthorized:${args.connectionId}:${args.deauthorizedAt.toISOString()}`,
      });
    }
  }
}
