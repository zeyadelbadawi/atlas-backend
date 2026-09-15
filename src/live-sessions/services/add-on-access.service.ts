/**
 * AddOnAccessService — "may this organization use this add-on right now,
 * and if not, WHICH condition failed?"
 *
 * FOUR INDEPENDENT CONDITIONS, REPORTED SEPARATELY. The product rule is
 * that these are genuinely different situations with different fixes, and
 * collapsing them into one boolean is what makes an add-on screen say
 * "unavailable" and leave the customer with nowhere to go:
 *
 *   subscription  — is the tenant's subscription even usable? A lapsed
 *                   customer cannot use add-ons, but the fix is billing.
 *   entitlement   — does the effective plan (plan + enabled add-ons) grant
 *                   the feature? The fix is upgrading or installing.
 *   installation  — has the tenant installed it at all? The fix is
 *                   installing, which they can do themselves.
 *   enablement    — installed, but switched off. The fix is one toggle.
 *
 * Reported in that order because it is the order in which the fixes make
 * sense: telling someone to enable an add-on their subscription cannot
 * support would be useless advice.
 *
 * IT REUSES THE EXISTING ENTITLEMENT ENGINE, and deliberately owns no rule
 * of its own. The feature flag it checks (`liveSessions`) is an ordinary
 * `PlanFeatureKey` resolved by `EntitlementService.computeEffectiveEntitlements`
 * — the same single formula the Usage page and every limit check use. The
 * add-on grants it through the `AddOnFeatureEffect` mechanism that already
 * existed for exactly this purpose; nothing here invents a parallel
 * entitlement model.
 *
 * THIS IS AN AUTHORITY, NOT A HINT. `assertUsable` is what controllers
 * call, and it throws. The frontend reads `describe` to render an honest
 * screen, but no client answer is ever trusted.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { EntitlementService } from '../../plans/services/entitlement.service';
import { TenantSubscriptionsRepository } from '../../plans/repositories/tenant-subscriptions.repository';
import { TenantAddOnsRepository } from '../../plans/repositories/tenant-add-ons.repository';
import { AddOnsRepository } from '../../plans/repositories/add-ons.repository';
import type {
  EntitlementAddOnInput,
  PlanFeatureKey,
} from '../../plans/dto/entitlement.types';
import { isAddOnDeferred } from '../constants/deferred-add-ons.constants';

/** The catalog key of the Live Sessions add-on. Data, resolved at runtime — never a hardcoded capability. */
export const LIVE_SESSIONS_ADD_ON_KEY = 'live-sessions';

/** The feature this add-on grants. Declared once so no controller spells it inline. */
export const LIVE_SESSIONS_FEATURE_KEY: PlanFeatureKey = 'liveSessions';

export const ADD_ON_NOT_USABLE_CODE = 'ADD_ON_NOT_USABLE';

/** Which condition failed. `null` when the add-on is fully usable. */
export type AddOnBlockReason =
  | 'subscription_inactive'
  | 'not_entitled'
  | 'not_installed'
  | 'disabled'
  | 'installing'
  | 'failed'
  // The add-on is implemented but its customer launch is deferred
  // ("Coming Soon"); see `DEFERRED_ADD_ON_KEYS`.
  | 'coming_soon';

export interface AddOnAccessState {
  readonly usable: boolean;
  readonly reason?: AddOnBlockReason;
  /** The tenant's lifecycle state for this add-on, when a row exists at all. */
  readonly installStatus?: string;
  /** Whether the effective entitlement grants the feature, independent of installation. */
  readonly entitled: boolean;
  readonly failureReason?: string;
}

/** Subscription statuses under which no add-on may be used. Mirrors the plans module's own inactive set. */
const INACTIVE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'no_plan',
  'trial_expired',
  'expired',
  'cancelled',
]);

@Injectable()
export class AddOnAccessService {
  constructor(
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    private readonly tenantAddOnsRepository: TenantAddOnsRepository,
    private readonly addOnsRepository: AddOnsRepository,
    private readonly entitlementService: EntitlementService,
  ) {}

  /**
   * The full picture, for rendering an honest add-on screen.
   *
   * Never throws for an ordinary "not usable" outcome — that is a state to
   * display, not an error.
   */
  async describe(
    tx: Prisma.TransactionClient,
    organizationId: string,
    addOnKey: string,
    featureKey: PlanFeatureKey,
  ): Promise<AddOnAccessState> {
    // COMING SOON / DEFERRED. An add-on whose customer launch is deferred is
    // never usable by a tenant — regardless of subscription, entitlement, or
    // an install row that may already exist — so every customer create,
    // publish, join and provisioning path fails closed here at the single
    // access choke point. Removing the key from `DEFERRED_ADD_ON_KEYS`
    // re-opens it. Platform-owner monitoring does not go through this method.
    if (isAddOnDeferred(addOnKey)) {
      return { usable: false, reason: 'coming_soon', entitled: false };
    }

    const subscription = await this.tenantSubscriptionsRepository.findByOrganizationId(
      tx,
      organizationId,
    );

    if (!subscription || INACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
      return { usable: false, reason: 'subscription_inactive', entitled: false };
    }

    // Effective entitlements = plan + every ENABLED add-on's effect. The
    // Live Sessions add-on grants `liveSessions` this way, so installing
    // and enabling it is literally what flips this to true.
    const activeAddOns = await this.tenantAddOnsRepository.findManyForOrganization(
      tx,
      organizationId,
    );
    const addOnInputs: EntitlementAddOnInput[] = activeAddOns.map((row) => ({
      effect: row.addOn.effect as unknown as EntitlementAddOnInput['effect'],
      compatiblePlanKeys: row.addOn.compatiblePlanKeys,
    }));

    const entitlements = this.entitlementService.computeEffectiveEntitlements(
      organizationId,
      {
        key: subscription.plan.key,
        limits: subscription.plan.limits as never,
        features: subscription.plan.features as never,
      },
      addOnInputs,
    );
    const entitled = this.entitlementService.hasFeature(entitlements, featureKey);

    const catalogAddOn = await this.addOnsRepository.findByKey(addOnKey);
    const installation = catalogAddOn
      ? await this.tenantAddOnsRepository.findOne(tx, organizationId, catalogAddOn.id)
      : null;

    if (!installation || installation.status === 'uninstalled') {
      return { usable: false, reason: 'not_installed', entitled };
    }

    if (installation.status === 'installing' || installation.status === 'uninstalling') {
      return {
        usable: false,
        reason: 'installing',
        installStatus: installation.status,
        entitled,
      };
    }

    if (installation.status === 'failed') {
      return {
        usable: false,
        reason: 'failed',
        installStatus: installation.status,
        entitled,
        failureReason: installation.failureReason ?? undefined,
      };
    }

    if (installation.status !== 'enabled') {
      return {
        usable: false,
        reason: 'disabled',
        installStatus: installation.status,
        entitled,
      };
    }

    // Enabled, but the plan still does not grant it — possible when the
    // add-on's effect is limit-based, or after a downgrade made the plan
    // incompatible. Entitlement is the authority, not the install row.
    if (!entitled) {
      return {
        usable: false,
        reason: 'not_entitled',
        installStatus: installation.status,
        entitled,
      };
    }

    return { usable: true, installStatus: installation.status, entitled: true };
  }

  /**
   * The enforcement point. Every Live Sessions mutation goes through this
   * before doing anything, so a client that hid the UI state or called the
   * API directly is refused identically.
   */
  async assertUsable(
    tx: Prisma.TransactionClient,
    organizationId: string,
    addOnKey: string = LIVE_SESSIONS_ADD_ON_KEY,
    featureKey: PlanFeatureKey = LIVE_SESSIONS_FEATURE_KEY,
  ): Promise<void> {
    const state = await this.describe(tx, organizationId, addOnKey, featureKey);
    if (state.usable) return;

    throw new ForbiddenException({
      messageKey: 'errors.liveSessions.addOnNotUsable',
      code: ADD_ON_NOT_USABLE_CODE,
      details: { reason: state.reason ?? 'not_installed' },
    });
  }
}
