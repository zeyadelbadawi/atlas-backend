/**
 * `GET/PATCH /users/me/communication-preferences` — P64 Communications C3.
 * Reads and writes `users.preferences` through P1's own
 * `UsersRepository.mergePreferences`, never a second store. The write
 * merges INSIDE the `notifications` sub-object here (the repository's
 * `||` is a top-level merge and would otherwise drop the legacy
 * `email/push/sms` flags, or vice versa).
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import {
  resolveCommunicationPreferences,
  type CommunicationPreferences,
  type StoredCommunicationCategories,
} from './communication-preferences.util';
import type { UpdateCommunicationPreferencesDto } from '../dto/update-communication-preferences.dto';

@Injectable()
export class CommunicationPreferencesService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly tenancyContextService: TenancyContextService,
  ) {}

  async get(userId: string): Promise<CommunicationPreferences> {
    const user = await this.usersRepository.findById(userId);
    if (!user) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return resolveCommunicationPreferences(user.preferences, {
      isStaff: await this.isStaff(userId),
    });
  }

  async update(
    userId: string,
    dto: UpdateCommunicationPreferencesDto,
  ): Promise<CommunicationPreferences> {
    const user = await this.usersRepository.findById(userId);
    if (!user) throw new NotFoundException({ messageKey: 'errors.notFound' });
    const isStaff = await this.isStaff(userId);

    const preferences = (user.preferences ?? {}) as {
      notifications?: Record<string, unknown> | null;
    };
    const notifications = { ...(preferences.notifications ?? {}) };
    const current = (notifications.categories ?? {}) as StoredCommunicationCategories;
    const categories: StoredCommunicationCategories = {
      lifecycle: { ...current.lifecycle, ...dto.lifecycle },
      engagement: { ...current.engagement, ...dto.engagement },
      // Operational settings exist only for staff; a learner's PATCH of
      // them is accepted by the DTO but never persisted.
      operational: isStaff
        ? { ...current.operational, ...dto.operational }
        : current.operational,
    };
    if (dto.engagement?.email !== undefined) {
      // Keep the legacy flag in step so `GET /notifications/preferences`
      // and older clients keep telling the truth.
      notifications.email = dto.engagement.email;
    }

    const partial: Record<string, unknown> = {
      notifications: { ...notifications, categories },
    };
    if (dto.language) partial.language = dto.language;

    const updated = await this.usersRepository.mergePreferences(userId, partial);
    return resolveCommunicationPreferences(updated.preferences, { isStaff });
  }

  /** Any organisation or academy membership — read as the person themself (`*_self_select`). */
  private async isStaff(userId: string): Promise<boolean> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const [organizations, academies] = await Promise.all([
        tx.organizationMembership.count({ where: { userId } }),
        tx.academyMember.count({ where: { userId } }),
      ]);
      return organizations + academies > 0;
    });
  }
}
