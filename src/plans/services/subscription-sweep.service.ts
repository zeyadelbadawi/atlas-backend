/**
 * SubscriptionSweepService — the single periodic job body Phase 2's one
 * scheduling mechanism (`SubscriptionSweepProcessor`, BullMQ repeatable
 * job) runs. Two responsibilities, deliberately combined into the SAME
 * scheduled tick rather than two separate schedulers (roadmap: "Use one
 * mechanism for both trial expiry and usage recomputation"):
 *
 *   1. `SubscriptionExpiryService.expireDueTrials` — transitions every
 *      organization whose trial has run out to `'expired'`.
 *   2. A platform-wide usage-recompute SAFETY NET: enqueues
 *      `TenantUsageRecomputeProducer.enqueueOne` for every organization on
 *      the platform. This is additive to (never a replacement for) the
 *      real, reactive triggers wired directly into the academy/course/
 *      enrollment/media write paths (see those services' own call sites)
 *      — those keep the Usage page current within moments of a real
 *      change; this sweep exists so a transient failure in one reactive
 *      trigger (or a metric affected by a change this phase did not
 *      itself enumerate) can never leave a `tenant_usage` row stale
 *      forever without a manual ops script, matching the roadmap's own
 *      acceptance criterion verbatim ("without requiring a manual ops
 *      script to be run").
 *
 * Enumerating every organization on the platform relies on the same
 * Platform Owner cross-tenant bypass `SubscriptionExpiryService` already
 * uses (`organizations_platform_select`, P15) — one platform-owner id
 * resolution, reused for both halves of this one sweep.
 */
import { Injectable, Logger } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { OrganizationsRepository } from '../../tenancy/repositories/organizations.repository';
import { SubscriptionExpiryService } from './subscription-expiry.service';
import { TenantUsageRecomputeProducer } from '../queue/tenant-usage-recompute.producer';

@Injectable()
export class SubscriptionSweepService {
  private readonly logger = new Logger(SubscriptionSweepService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly organizationsRepository: OrganizationsRepository,
    private readonly subscriptionExpiryService: SubscriptionExpiryService,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
  ) {}

  async run(): Promise<void> {
    const expiredCount = await this.subscriptionExpiryService.expireDueTrials();

    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.warn(
        'No platform owner account exists yet — skipping the usage-recompute safety-net sweep.',
      );
      return;
    }

    const organizations = await this.tenancyContextService.runInUserContext(
      platformOwner.id,
      (tx) => this.organizationsRepository.findAllIdsPlatformWide(tx),
    );

    for (const organization of organizations) {
      await this.tenantUsageRecomputeProducer.enqueueOne(organization.id);
    }

    this.logger.log(
      { expiredCount, recomputeEnqueuedCount: organizations.length },
      'Subscription sweep tick complete.',
    );
  }
}
