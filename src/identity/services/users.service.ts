/**
 * UsersService — the authenticated `/users/me*` surface (master plan §21
 * Phase P1, §5/§6/§7 of the P1 spec: profile, preferences, change-password;
 * extended in Phase P2 to populate real organization data — §20).
 */
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersRepository } from '../repositories/users.repository';
import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';
import { PasswordHasherService } from './password-hasher.service';
import { toCurrentUser } from '../dto/contracts';
import type { CurrentUserResponse, UserPreferences } from '../dto/contracts';
import { UserOrganizationsService } from '../../tenancy/services/user-organizations.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { NotificationFanoutService } from '../../notification-events/services/notification-fanout.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly refreshTokensRepository: RefreshTokensRepository,
    private readonly passwordHasher: PasswordHasherService,
    private readonly userOrganizationsService: UserOrganizationsService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly notificationFanoutService: NotificationFanoutService,
  ) {}

  async getCurrent(userId: string): Promise<CurrentUserResponse> {
    const user = await this.requireUser(userId);
    const organizationMemberships =
      await this.userOrganizationsService.getMembershipsForUser(userId);
    return toCurrentUser(user, organizationMemberships);
  }

  async updateProfile(
    userId: string,
    input: { name?: string; avatar?: string },
  ): Promise<CurrentUserResponse> {
    await this.requireUser(userId);
    const updated = await this.usersRepository.updateProfile(userId, {
      name: input.name,
      avatarUrl: input.avatar,
    });
    const organizationMemberships =
      await this.userOrganizationsService.getMembershipsForUser(userId);
    return toCurrentUser(updated, organizationMemberships);
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
    return toCurrentUser(updated, organizationMemberships);
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
    const user = await this.requireUser(userId);

    const currentValid = await this.passwordHasher.verify(
      user.passwordHash,
      currentPassword,
    );
    if (!currentValid) {
      throw new UnauthorizedException({
        messageKey: 'errors.auth.invalidCurrentPassword',
      });
    }

    const newHash = await this.passwordHasher.hash(newPassword);
    await this.usersRepository.updatePasswordHash(userId, newHash);
    await this.refreshTokensRepository.revokeAllForUser(userId);

    // Phase P17 — a security-relevant event that should fire every time,
    // never deduped (see `Notification`'s own schema.prisma doc comment:
    // "a security alert... simply passes `dedupeKey: null`"). No existing
    // shared transaction to append to here (this method's own writes
    // above are already two separate, non-transactional calls) — opens
    // its own small transaction just for the notification insert, the
    // same narrow exception `AuditLogWriterService.writeBestEffort`
    // documents for this exact situation (P1's password-reset-confirm).
    const notifiedNew = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      this.notificationFanoutService.notify(tx, {
        userId,
        type: 'security',
        priority: 'high',
        titleKey: 'notifications:events.passwordChanged.title',
        messageKey: 'notifications:events.passwordChanged.message',
        dedupeKey: null,
      }),
    );
    await this.notificationFanoutService.sendEmailAfterCommit(userId, notifiedNew, {
      template: 'password_changed',
    });
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
