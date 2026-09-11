/**
 * Marks a mutation that must keep working when a subscription has lapsed.
 *
 * THE ALLOWLIST IS THE WHOLE DESIGN. Locking an expired tenant out of
 * everything includes locking them out of paying, which turns a recoverable
 * billing problem into a lost customer and a support ticket. The routes
 * marked with this are exactly the ones a customer needs in order to STOP
 * being expired — starting a trial, creating a checkout, submitting a
 * payment, changing plan, cancelling — plus the account-level actions that
 * were never tenant-scoped in the first place.
 *
 * It is deliberately a decorator rather than a path list. A list of URLs in
 * a config file drifts the moment a route is renamed, and the drift is
 * silent in the dangerous direction: the route stops being allowed and a
 * paying customer cannot pay. Marking the handler keeps the exemption next
 * to the thing exempted, where a reviewer sees it.
 *
 * Applying it to a CLASS exempts every handler on that controller — correct
 * for a controller that is entirely about billing, and something to think
 * twice about anywhere else.
 */
import { SetMetadata } from '@nestjs/common';

export const ALLOW_INACTIVE_SUBSCRIPTION_KEY = 'allowInactiveSubscription';

export const AllowInactiveSubscription = () =>
  SetMetadata(ALLOW_INACTIVE_SUBSCRIPTION_KEY, true);
