/**
 * Which video security tier applies (master plan D10, D11, AD-15).
 *
 * THE CHAIN, and why each link exists:
 *
 *   plan family  →  entitled tier  →  academy choice  →  the asset's tier
 *
 *   - **Plan family** (`normal` | `premium`) is what the customer bought.
 *     It is the CEILING: an academy on a Normal plan cannot select
 *     Premium, because nobody is paying for it.
 *   - **Academy choice** is what new uploads get, within that ceiling. A
 *     Premium-entitled academy may deliberately keep some academies on
 *     Normal — the entitlement is permission, not obligation.
 *   - **The asset's tier** is historical and is NEVER recomputed from
 *     either of the above (D11). That is the whole reason `resolve` is
 *     only ever called on the UPLOAD path.
 *
 * Nothing here names a provider class. D10 requires that `premium` is not
 * hard-wired to `CloudflareStreamProvider` in the authorization layer, so
 * this service answers in tiers and `VideoProviderRegistry` — one layer
 * down, in the media module — is the only place that knows which adapter
 * serves which tier.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma, VideoSecurityTier } from '@prisma/client';
import { TenantSubscriptionsRepository } from '../repositories/tenant-subscriptions.repository';

export interface ResolvedVideoTier {
  /** The tier NEW uploads will be created under. */
  readonly tier: VideoSecurityTier;
  /** The ceiling the plan family allows. */
  readonly entitled: VideoSecurityTier;
  /** Which level actually decided, for the settings screen and the audit trail. */
  readonly source: 'academy' | 'plan';
}

@Injectable()
export class VideoTierService {
  constructor(
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
  ) {}

  /**
   * The highest tier this organization's plan family entitles.
   *
   * A missing or unreadable subscription resolves to `normal`, never
   * `premium`: an entitlement nobody can prove was purchased must not be
   * granted by a lookup failure.
   */
  async entitledTier(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<VideoSecurityTier> {
    const subscription = await this.tenantSubscriptionsRepository.findByOrganizationId(
      tx,
      organizationId,
    );
    return subscription?.plan.family === 'premium' ? 'premium' : 'normal';
  }

  /**
   * The tier an academy's NEW uploads land on.
   *
   * The academy's stored choice wins when it is within the entitlement.
   * A stored choice ABOVE the entitlement is ignored rather than honoured
   * — which is exactly the state an academy is left in after downgrading,
   * and the reason the stored value is not cleared on a plan change: if
   * they upgrade again, their original preference is still there.
   */
  async resolve(
    tx: Prisma.TransactionClient,
    args: { readonly academyId: string; readonly organizationId: string },
  ): Promise<ResolvedVideoTier> {
    const [entitled, academy] = await Promise.all([
      this.entitledTier(tx, args.organizationId),
      tx.academy.findUnique({
        where: { id: args.academyId },
        select: { videoSecurityTier: true },
      }),
    ]);

    const chosen = academy?.videoSecurityTier ?? null;
    if (chosen === 'premium' && entitled === 'premium') {
      return { tier: 'premium', entitled, source: 'academy' };
    }
    if (chosen === 'normal') {
      return { tier: 'normal', entitled, source: 'academy' };
    }
    // No choice, or a choice the plan no longer supports.
    return { tier: entitled, entitled, source: 'plan' };
  }

  /**
   * Refuses a tier the plan does not entitle.
   *
   * Refused rather than silently lowered: an owner shown "Premium" whose
   * learners get Normal has been told something untrue, and the same
   * reasoning already governs the academy device policy.
   */
  async assertEntitled(
    tx: Prisma.TransactionClient,
    organizationId: string,
    requested: VideoSecurityTier,
  ): Promise<void> {
    const entitled = await this.entitledTier(tx, organizationId);
    if (requested === 'premium' && entitled !== 'premium') {
      throw new ForbiddenException({
        messageKey: 'errors.entitlement.videoTierNotEntitled',
        code: 'ENTITLEMENT_VIDEO_TIER',
        details: { requested, entitled },
      });
    }
  }
}
