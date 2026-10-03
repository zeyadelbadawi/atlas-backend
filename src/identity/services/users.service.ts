/**
 * UsersService — the authenticated `/users/me*` surface (master plan §21
 * Phase P1, §5/§6/§7 of the P1 spec: profile, preferences, change-password;
 * extended in Phase P2 to populate real organization data — §20).
 */
import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import {
  isLearnerNameTaken,
  isUniqueViolation,
  lockLearnerName,
  profileNameTakenInAcademy,
  requireNameKey,
} from '../../common/name-uniqueness/name-uniqueness';
import { UsersRepository } from '../repositories/users.repository';
import { PasswordResetTokensRepository } from '../repositories/password-reset-tokens.repository';
import { SessionRevocationService } from './session-revocation.service';
import { PasswordCredentialsService } from './password-credentials.service';
import { toCurrentUser } from '../dto/contracts';
import type { CurrentUserResponse, UserPreferences } from '../dto/contracts';
import { UserOrganizationsService } from '../../tenancy/services/user-organizations.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CommunicationService } from '../../communications/services/communication.service';
import type { EmitResult } from '../../communications/services/communication.service';
import { PrincipalResolverService } from '../../tenancy/services/principal-resolver.service';
import { SurfaceEnforcementService } from '../../tenancy/services/surface-enforcement.service';
import { TrustedDeviceService } from './trusted-device.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import type { Principal } from '../../tenancy/services/principal-resolver.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly sessionRevocationService: SessionRevocationService,
    private readonly passwordCredentials: PasswordCredentialsService,
    private readonly userOrganizationsService: UserOrganizationsService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly communicationService: CommunicationService,
    private readonly principalResolver: PrincipalResolverService,
    private readonly surfaceEnforcement: SurfaceEnforcementService,
    private readonly trustedDeviceService: TrustedDeviceService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly passwordResetTokensRepository: PasswordResetTokensRepository,
  ) {}

  /**
   * P64 Phase 1 (§T) — the principal plus the rollout's answer for them,
   * so `/users/me` reports whether the surface refusal actually applies
   * rather than leaving the frontend to assume it does.
   */
  private withSurfaceState(principal: Principal) {
    return {
      ...principal,
      managementSurfaceEnforced: this.surfaceEnforcement.isEnforcedFor(principal),
    };
  }

  async getCurrent(userId: string): Promise<CurrentUserResponse> {
    const user = await this.requireUser(userId);
    const [organizationMemberships, principal] = await Promise.all([
      this.userOrganizationsService.getMembershipsForUser(userId),
      this.principalResolver.resolve(userId),
    ]);
    return toCurrentUser(user, organizationMemberships, this.withSurfaceState(principal));
  }

  async updateProfile(
    userId: string,
    input: { name?: string; avatar?: string },
  ): Promise<CurrentUserResponse> {
    await this.requireUser(userId);
    const updated =
      input.name === undefined
        ? await this.usersRepository.updateProfile(userId, { avatarUrl: input.avatar })
        : await this.renameUnderLearnerNameRule(userId, input.name, input.avatar);
    const organizationMemberships =
      await this.userOrganizationsService.getMembershipsForUser(userId);
    return toCurrentUser(
      updated,
      organizationMemberships,
      this.withSurfaceState(await this.principalResolver.resolve(userId)),
    );
  }

  /**
   * W4 — a learner's name is unique inside each academy they belong to, and
   * it is ONE account name shared by all of them, so a rename is checked in
   * every academy where the user's row is not exempt. A clash refuses the
   * rename (409 `errors.profile.nameTakenInAcademy`) and lists only the
   * user's OWN academies — never anything about the other learner.
   *
   * Runs in one transaction: lock each 'learner-name:<academy>:<key>' (in a
   * fixed order, so two renames cannot deadlock), ask the boolean definer
   * check, then update. The `users_learner_name_key_au` trigger moves every
   * academy row's key; the partial unique index is the final truth, and a
   * P2002 from it is classified by asking again in a fresh transaction.
   */
  private async renameUnderLearnerNameRule(
    userId: string,
    name: string,
    avatar: string | undefined,
  ): Promise<User> {
    let key = '';
    try {
      return await this.tenancyContextService.runInUserContext(userId, async (tx) => {
        key = await requireNameKey(tx, name, 'name');
        const clashes = await this.learnerNameClashes(tx, userId, key, true);
        if (clashes.length > 0) throw await this.profileNameConflict(userId, clashes);
        return this.usersRepository.updateProfile(
          userId,
          { name, avatarUrl: avatar },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error) && key !== '') {
        const clashes = await this.tenancyContextService.runInUserContext(userId, (tx) =>
          this.learnerNameClashes(tx, userId, key, false),
        );
        if (clashes.length > 0) throw await this.profileNameConflict(userId, clashes);
      }
      throw error;
    }
  }

  /** The user's academies (non-exempt rows only) where another learner holds `key`. */
  private async learnerNameClashes(
    tx: Prisma.TransactionClient,
    userId: string,
    key: string,
    lock: boolean,
  ): Promise<string[]> {
    const rows = await tx.academyStudent.findMany({
      where: { userId, nameUniqueExempt: false },
      select: { academyId: true },
      orderBy: { academyId: 'asc' },
    });
    const clashes: string[] = [];
    for (const { academyId } of rows) {
      if (lock) await lockLearnerName(tx, academyId, key);
      if (await isLearnerNameTaken(tx, academyId, key, userId)) clashes.push(academyId);
    }
    return clashes;
  }

  private async profileNameConflict(
    userId: string,
    academyIds: readonly string[],
  ): Promise<ConflictException> {
    const own = await this.principalResolver.resolveLearnerAcademies(userId);
    const wanted = new Set(academyIds);
    return profileNameTakenInAcademy(
      own
        .filter((academy) => wanted.has(academy.academyId))
        .map((academy) => ({ academyId: academy.academyId, name: academy.name })),
    );
  }

  async updatePreferences(
    userId: string,
    partial: Partial<UserPreferences>,
  ): Promise<CurrentUserResponse> {
    await this.requireUser(userId);
    // `mergePreferences` is scoped by `id` and merges atomically in
    // Postgres — there is no code path by which this can touch another
    // user's row, and no read-modify-write race between concurrent calls
    // for the same user.
    const updated = await this.usersRepository.mergePreferences(userId, partial);
    const organizationMemberships =
      await this.userOrganizationsService.getMembershipsForUser(userId);
    return toCurrentUser(
      updated,
      organizationMemberships,
      this.withSurfaceState(await this.principalResolver.resolve(userId)),
    );
  }

  /**
   * Verifies the current password, rotates to the new one, and revokes
   * every existing refresh token for the account (master plan §21 P1
   * "Change password": "revoke existing refresh tokens after password
   * change; issue no automatic new session"). The access token used to
   * call this endpoint keeps working until its own short natural
   * expiration — only refresh is cut off, matching the frontend contract
   * (`changePassword` returns `Promise<void>`, no new tokens).
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await this.requireUser(userId);

    const currentValid = await this.passwordCredentials.verify(userId, currentPassword);
    if (!currentValid) {
      throw new UnauthorizedException({
        messageKey: 'errors.auth.invalidCurrentPassword',
      });
    }

    await this.passwordCredentials.set(userId, newPassword);
    // An outstanding reset/setup link would otherwise still be able to set
    // the password the owner just changed.
    await this.passwordResetTokensRepository.spendAllForUser(userId);
    // Launch Stabilization A3 (D3) — refresh rows AND live access tokens,
    // including this one: the old password may be in someone else's hands.
    const sessionsRevoked = await this.sessionRevocationService.revokeAllSessionsForUser(
      userId,
      'password_change',
    );
    // P64 Communications C4 (§12) — trust is revoked by a password change
    // for the same reason every session is: a browser that could still
    // skip the emailed code would keep whoever knew the OLD password a
    // step ahead of the owner who just changed it.
    const trustedDevicesRevoked = await this.trustedDeviceService.revokeAllForUser(
      userId,
      'password_change',
    );
    // Launch Stabilization A3 — the durable security record of what the
    // credential change ended. Best-effort in its own small transaction
    // (the documented `writeBestEffort` pattern): the revocation above has
    // already happened and must never be undone by an audit failure.
    await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.auditLogWriterService.writeBestEffort(tx, {
        actorUserId: userId,
        action: 'auth.sessions.revoked',
        targetType: 'user',
        targetId: userId,
        context: { trigger: 'password_change', sessionsRevoked, trustedDevicesRevoked },
      }),
    );

    // Phase P17 — a security-relevant event that should fire every time,
    // never deduped (see `Notification`'s own schema.prisma doc comment:
    // "a security alert... simply passes `dedupeKey: null`"). No existing
    // shared transaction to append to here (this method's own writes
    // above are already two separate, non-transactional calls) — opens
    // its own small transaction just for the notification insert, the
    // same narrow exception `AuditLogWriterService.writeBestEffort`
    // documents for this exact situation (P1's password-reset-confirm).
    const emitted: EmitResult = await this.tenancyContextService.runInUserContext(
      userId,
      (tx) =>
        this.communicationService.emit(tx, {
          key: 'auth.password.changed',
          recipientUserId: userId,
          entity: { type: 'user', id: userId },
        }),
    );
    await this.communicationService.enqueueAfterCommit(emitted.outboxId);
  }

  private async requireUser(userId: string) {
    const user = await this.usersRepository.findById(userId);
    if (!user) {
      // The access token's signature is valid but the account behind `sub`
      // is gone — treat identically to "not authenticated," not a 404,
      // since there's no resource to name from the caller's point of view.
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }
    return user;
  }
}
