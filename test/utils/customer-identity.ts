/**
 * W8 — e2e helpers for the customer-identity ledgers.
 *
 * The application writes v2 (HMAC under the server key) subject hashes to
 * `trial_redemptions` and `paid_gift_redemptions`. Tests compute the same
 * digest from the same environment the app booted with, so they can look a
 * subject's rows up without ever storing or logging an address.
 */
import { customerIdentityKeyFromEnv } from '../../src/plans/utils/customer-identity-key.util';
import {
  customerSubjectHashV2,
  legacySubjectHashV1,
} from '../../src/plans/utils/trial-subject.util';

/** The v2 subject hash every new ledger row stores. */
export function ledgerSubjectHash(email: string): string {
  return customerSubjectHashV2(email, customerIdentityKeyFromEnv());
}

/** The frozen pre-W8 (v1) trial subject hash. */
export function legacyLedgerSubjectHash(email: string): string {
  return legacySubjectHashV1(email);
}
