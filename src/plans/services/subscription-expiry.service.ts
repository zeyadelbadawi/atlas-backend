/**
 * SubscriptionExpiryService — Phase 2 (Decision 6). The one place a
 * `'trialing'` subscription is physically transitioned to `'expired'`
 * once its 3-day clock runs out — "must transition automatically and
 * reliably ... no manual intervention" (roadmap §1, Decision 6).
 *
 * Runs under the Platform Owner's own RLS bypass
 * (`runInUserContext(<a real platform-owner id>)`), the exact same
 * mechanism every other genuinely cross-tenant Platform Owner read/write
 * in this codebase already uses (`PlatformOrganizationsService`,
 * `PlatformProvisioningService`) — never a second, parallel "system"
 * bypass. `UsersRepository.findFirstPlatformOwnerId` resolves which real
 * user id to run under; if none exists yet (a schema freshly migrated but
 * never seeded/bootstrapped), the sweep logs a warning and does nothing
 * rather than crash the scheduler — there is no organization able to be
 * expired if the platform itself has no owner account yet either.
 *
 * `expireDueTrials` is directly callable — by
 * `SubscriptionSweepProcessor` (the real, scheduled, production path) AND
 * by tests, which seed a `trialEndsAt` already in the past and call this
 * method directly rather than actually waiting three days or manipulating
 * the system clock (the "controlled/fast-forwarded clock" the roadmap's
 * own testing section asks for).
 */
import { Injectable, Logger } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { TenantSubscriptionsRepository } from '../repositories/tenant-subscriptions.repository';

@Injectable()
export class SubscriptionExpiryService {
  private readonly logger = new Logger(SubscriptionExpiryService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
  ) {}

  /** Returns the number of subscriptions actually transitioned, for logging/test assertions. */
  async expireDueTrials(now: Date = new Date()): Promise<number> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.warn(
        'No platform owner account exists yet — skipping trial-expiry sweep.',
      );
      return 0;
    }

    const due = await this.tenancyContextService.runInUserContext(
      platformOwner.id,
      (tx) => this.tenantSubscriptionsRepository.findManyDueForTrialExpiry(tx, now),
    );

    for (const subscription of due) {
      await this.tenancyContextService.runInUserContext(platformOwner.id, (tx) =>
        this.tenantSubscriptionsRepository.markExpired(tx, subscription.organizationId),
      );
    }

    if (due.length > 0) {
      this.logger.log({ count: due.length }, 'Expired due trial subscriptions.');
    }

    return due.length;
  }
}
