/**
 * Device list, session list and TAKEOVER for the learner's own account
 * (master plan Phase 2 §D.7, §E.1's Devices section, §L).
 *
 * TAKEOVER IS THE LEARNER'S OWN, CONFIRMED REQUEST — never something
 * Atlas does for them. The flow §D.7 specifies is inform → confirm →
 * revoke the previous lease and block its token refresh → activate →
 * audit, and the "confirm" step is the whole point: the single-session
 * rule exists to make account sharing inconvenient, and a takeover that
 * happened silently would make it invisible instead. The person on the
 * other device must be able to see that they were displaced.
 *
 * BLOCKING THE PREVIOUS SESSION'S TOKEN REFRESH is what makes a takeover
 * stick. Dropping the lease alone would let the displaced browser simply
 * re-acquire it at its next heartbeat, and the two devices would trade it
 * back and forth indefinitely. Revoking the previous session's refresh
 * token means that browser's access token expires and is not renewed.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AccessPolicyService } from '../../tenancy/services/access-policy.service';
import { StudentDeviceService } from '../../tenancy/services/student-device.service';
import { hashDeviceCookie } from '../../tenancy/services/student-device.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { LearningLeaseService } from './learning-lease.service';
import { VideoGateRevocationService } from '../../media/video/video-gate-revocation.service';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import { CommunicationService } from '../../communications/services/communication.service';
import type { EmitResult } from '../../communications/services/communication.service';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { SessionRevocationService } from '../../identity/services/session-revocation.service';
import type {
  LearnerDevicesResponse,
  LearnerDeviceResponse,
  LearnerSessionResponse,
} from '../dto/learner-overview.contract';

export interface TakeoverResult {
  readonly leaseId: string;
  readonly ttlSeconds: number;
  readonly heartbeatSeconds: number;
  readonly displacedDeviceLabel: string | null;
}

@Injectable()
export class LearnerSessionService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly studentDeviceService: StudentDeviceService,
    private readonly accessPolicyService: AccessPolicyService,
    private readonly leaseService: LearningLeaseService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly gateRevocation: VideoGateRevocationService,
    private readonly metrics: LearningMetricsService,
    private readonly communications: CommunicationService,
    private readonly academiesRepository: AcademiesRepository,
    private readonly sessionRevocation: SessionRevocationService,
  ) {}

  async listDevices(
    userId: string,
    academyId: string,
    context: { readonly deviceCookie?: string | null; readonly sessionId: string },
  ): Promise<LearnerDevicesResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const [devices, policy, sessions] = await Promise.all([
        this.studentDeviceService.listActive(tx, userId, academyId),
        this.accessPolicyService.resolveForAcademy(tx, academyId),
        // Academy-surface sessions only: a learner's Devices page must not
        // list (or offer to end) a management session they hold as staff
        // of some other organization.
        tx.refreshToken.findMany({
          where: {
            userId,
            academyId,
            surface: 'academy',
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          orderBy: { lastUsedAt: 'desc' },
          select: {
            sessionId: true,
            deviceLabel: true,
            locationCountry: true,
            lastUsedAt: true,
            createdAt: true,
          },
          distinct: ['sessionId'],
        }),
      ]);

      const currentHash = context.deviceCookie
        ? hashDeviceCookie(context.deviceCookie)
        : null;

      const deviceResponses: LearnerDeviceResponse[] = devices.map((device) => ({
        id: device.id,
        label: device.label,
        lastSeenAt: device.lastSeenAt.toISOString(),
        createdAt: device.createdAt.toISOString(),
        current: currentHash !== null && device.cookieHash === currentHash,
      }));

      const sessionResponses: LearnerSessionResponse[] = sessions.map((session) => ({
        sessionId: session.sessionId,
        deviceLabel: session.deviceLabel,
        locationCountry: session.locationCountry,
        lastUsedAt: session.lastUsedAt?.toISOString() ?? null,
        createdAt: session.createdAt.toISOString(),
        current: session.sessionId === context.sessionId,
      }));

      return {
        devices: deviceResponses,
        sessions: sessionResponses,
        maxDevices: policy.maxDevices,
        maxConcurrentSessions: policy.maxConcurrentSessions,
        policySource: policy.source,
      };
    });
  }

  /**
   * Removes one of the learner's own devices.
   *
   * Also ends the SESSIONS bound to it. A removed device whose browser
   * kept a working session would be removed in name only: the learner
   * sees it gone from the list while it carries on playing. Removing a
   * device is the action a learner takes when they no longer control it,
   * so it has to actually end access there.
   */
  async removeDevice(userId: string, academyId: string, deviceId: string): Promise<void> {
    // P64 Communications C3 (plan §8 B2). Declared out here so the hint
    // can be sent once the transaction has committed.
    let emitted: EmitResult = { created: false, outboxId: null };
    const revokedSessionIds = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const removed = await this.studentDeviceService.revokeOwn(tx, userId, deviceId);
        if (!removed || removed.academyId !== academyId) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }

        // P64 Communications C3 (plan §8 B2, §10 "B1/B2 device
        // registered/removed"). `security` by §11, and emailed rather
        // than §10's "preference" because §23 locks a security
        // preference to on — see the catalogue's own note. Inside the
        // transaction that revokes the device and its sessions, so a
        // removal that rolls back (the `NotFoundException` above, a
        // failing session revoke) tells nobody.
        //
        // No academy NAME is read here: this runs in the learner's own
        // user context and there is no `academies_student_select` policy,
        // so the row is invisible. The email's brand name comes from
        // `CommunicationBrandingService` after the commit, which has full
        // visibility — see `CourseCompletionService.recompute` for the
        // same note and the crash that made it explicit.
        emitted = await this.communications.emit(tx, {
          key: 'device.removed',
          recipientUserId: userId,
          academyId,
          entity: { type: 'student_device', id: removed.id },
          values: { deviceLabel: removed.label },
        });
        // Collected BEFORE revoking, because afterwards the rows no
        // longer match the filter and the gate would never be told.
        const sessions = await tx.refreshToken.findMany({
          where: { userId, deviceId, revokedAt: null },
          select: { sessionId: true },
          distinct: ['sessionId'],
        });
        await tx.refreshToken.updateMany({
          where: { userId, deviceId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        return sessions.map((session) => session.sessionId);
      },
    );

    // P64 Phase 2 — and stop the DELIVERY GATE honouring credentials
    // already in flight. Revoking the session alone only stops the next
    // grant; a Normal-tier URL already in the player would keep serving
    // for the rest of its ten minutes. Removing a device is what a
    // learner does when they no longer control it, so it has to actually
    // end access there.
    await this.gateRevocation.revokeSessions(revokedSessionIds, 'device_removed');
    // Device Identity + Device-Limit fix — and its ACCESS tokens, at once.
    // Revoking the refresh rows only stopped the next refresh: the removed
    // device's current access token kept every API open for up to its
    // remaining lifetime. The same denylist sign-out and refresh-reuse use.
    await Promise.all(
      revokedSessionIds.map((sessionId) => this.sessionRevocation.markRevoked(sessionId)),
    );
    // Outside the transaction: the lease store is not transactional, and a
    // rollback must not leave it holding a lease for a device that still
    // exists. Only the REMOVED device's lease goes — a learner freeing a
    // slot from one browser must not cut off the lesson playing on another.
    const lease = await this.leaseService.current(userId, academyId);
    if (lease?.deviceId === deviceId) {
      await this.leaseService.revokeAll(userId, academyId);
    }
    await this.communications.enqueueAfterCommit(emitted.outboxId);
  }

  /**
   * TAKEOVER — move the single learning session to this device.
   *
   * Runs only for the learner's OWN account (the id comes from the access
   * token), only for a device that is already registered to them, and
   * only after the frontend has shown the confirmation dialog. The audit
   * entry records both sides, which is what turns a sharing pattern into
   * something a Client Owner can actually see.
   */
  async takeover(
    userId: string,
    academyId: string,
    context: {
      readonly sessionId: string;
      readonly deviceCookie?: string | null;
      readonly courseId?: string;
      readonly lessonId?: string;
    },
  ): Promise<TakeoverResult> {
    const { device, previousDeviceLabel, previousSessionId } =
      await this.tenancyContextService.runInUserContext(userId, async (tx) => {
        if (!context.deviceCookie) {
          throw new ForbiddenException({ messageKey: 'errors.learning.deviceLimit' });
        }
        const claimed = await tx.studentDevice.findFirst({
          where: {
            userId,
            academyId,
            revokedAt: null,
            cookieHash: hashDeviceCookie(context.deviceCookie),
          },
        });
        // A takeover cannot register a new device. Allowing it to would
        // turn takeover into a way around the device cap: every refused
        // browser could simply "take over" its way in.
        if (!claimed) {
          throw new ForbiddenException({ messageKey: 'errors.learning.deviceLimit' });
        }

        const holder = await this.leaseService.current(userId, academyId);
        const previous = holder?.deviceId
          ? await tx.studentDevice.findUnique({
              where: { id: holder.deviceId },
              select: { label: true },
            })
          : null;

        return {
          device: claimed,
          previousDeviceLabel: previous?.label ?? null,
          previousSessionId: holder?.sessionId ?? null,
        };
      });

    const { lease } = await this.leaseService.takeover({
      userId,
      academyId,
      deviceId: device.id,
      sessionId: context.sessionId,
      courseId: context.courseId,
      lessonId: context.lessonId,
    });

    // Block the displaced session's token refresh, so it cannot simply
    // take the lease back at its next heartbeat.
    if (previousSessionId && previousSessionId !== context.sessionId) {
      await this.tenancyContextService.runInUserContext(userId, (tx) =>
        tx.refreshToken.updateMany({
          where: { userId, sessionId: previousSessionId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      );
      // And at the delivery gate, so the displaced browser stops PLAYING
      // rather than merely stopping at its next refresh. Without this a
      // takeover would look instant to the learner who requested it and
      // take up to ten minutes for the one being displaced.
      await this.gateRevocation.revokeSession(previousSessionId, 'session_taken_over');
    }

    this.metrics.recordTakeover();

    // P64 Communications C3 (plan §8 B4, §10 "B3 device limit, B4 session
    // takeover | yes (urgent) | never"). Only when a session was actually
    // DISPLACED: taking over from nobody is not an event, and the learner
    // who clicked is the same person either way — what makes this worth
    // telling is that some other browser just stopped playing.
    //
    // In its own transaction, after the lease has actually moved: the
    // takeover is the durable outcome and a notification failure must not
    // undo it. The instant is in the dedupe key, so trading the session
    // back and forth is reported every time rather than once.
    if (previousSessionId && previousSessionId !== context.sessionId) {
      const takenOverAt = new Date();
      const emitted = await this.tenancyContextService.runInUserContext(userId, (tx) =>
        this.communications.emit(tx, {
          key: 'session.taken_over',
          recipientUserId: userId,
          academyId,
          entity: { type: 'student_device', id: device.id },
          values: {
            takenOverAtMs: takenOverAt.getTime(),
            deviceLabel: device.label,
            previousDeviceLabel: previousDeviceLabel ?? '',
          },
        }),
      );
      await this.communications.enqueueAfterCommit(emitted.outboxId);
    }

    await this.writeTakeoverAudit(userId, academyId, {
      newDeviceId: device.id,
      newDeviceLabel: device.label,
      newSessionId: context.sessionId,
      previousDeviceLabel,
      previousSessionId,
      courseId: context.courseId ?? null,
      lessonId: context.lessonId ?? null,
    });

    return {
      leaseId: lease.leaseId,
      ttlSeconds: this.leaseService.ttlSeconds,
      heartbeatSeconds: this.leaseService.heartbeatSeconds,
      displacedDeviceLabel: previousDeviceLabel,
    };
  }

  /** Owner-initiated reset of one learner's device registry (Phase 2 §D.7). */
  async resetDevicesForStudent(
    tx: Prisma.TransactionClient,
    academyId: string,
    studentUserId: string,
  ): Promise<number> {
    const revoked = await this.studentDeviceService.revokeAllForStudent(
      tx,
      academyId,
      studentUserId,
    );
    await tx.refreshToken.updateMany({
      where: { userId: studentUserId, academyId, surface: 'academy', revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.leaseService.revokeAll(studentUserId, academyId);
    return revoked;
  }

  private async writeTakeoverAudit(
    userId: string,
    academyId: string,
    details: {
      readonly newDeviceId: string;
      readonly newDeviceLabel: string;
      readonly newSessionId: string;
      readonly previousDeviceLabel: string | null;
      readonly previousSessionId: string | null;
      readonly courseId: string | null;
      readonly lessonId: string | null;
    },
  ): Promise<void> {
    // `writeBestEffort` rather than `write`: a takeover has already taken
    // effect by the time this runs, and failing the request afterwards
    // would tell the learner it did not work while leaving them holding
    // the lease. The failure is logged where an operator can see it.
    // Task 3 — the organization id, resolved from the academy through the
    // SECURITY DEFINER lookup (a learner's own context cannot read the
    // academy row). The row previously carried only `academyId`, so the
    // owner's tenant-scoped feed could never see it.
    const organizationId =
      await this.academiesRepository.resolveOrganizationId(academyId);
    await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.auditLogWriterService.writeBestEffort(tx, {
        actorUserId: userId,
        organizationId: organizationId ?? undefined,
        academyId,
        role: 'student',
        action: 'learning.device_session_takeover',
        targetType: 'student_device',
        targetId: details.newDeviceId,
        targetLabel: details.newDeviceLabel,
        // Flat, non-secret scalars only — never the device cookie, which
        // is a credential, and never a raw session token.
        context: {
          newSessionId: details.newSessionId,
          previousDeviceLabel: details.previousDeviceLabel,
          previousSessionId: details.previousSessionId,
          courseId: details.courseId,
          lessonId: details.lessonId,
        },
      }),
    );
  }
}
