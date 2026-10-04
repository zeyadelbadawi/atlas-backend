/**
 * CustomerIdentityHasher — the ONE place a customer email becomes a ledger
 * subject (W8B). Both `TrialEligibilityService` and
 * `PaidGiftEligibilityService` go through it, so the trial ledger and the
 * gifted-days ledger always agree on who "the same customer" is: same
 * canonicalization (alias collapsing included), same server key.
 *
 * It returns digests only. The email, its canonical form and the key never
 * leave this class, and nothing here logs.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentConfigurationConfig } from '../../config/configuration';
import { deriveCustomerIdentityKey } from '../utils/customer-identity-key.util';
import {
  customerSubjectHashes,
  type CustomerSubjectHashes,
} from '../utils/trial-subject.util';

/** The `hash_version` value every new ledger row carries. */
export const CURRENT_SUBJECT_HASH_VERSION = 2;

@Injectable()
export class CustomerIdentityHasher {
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const config =
      configService.getOrThrow<PaymentConfigurationConfig>('paymentConfiguration');
    this.key = deriveCustomerIdentityKey({
      dedicatedKeyHex: config.customerIdentityKeyHex,
      paymentCredentialsKeyHex: config.credentialEncryptionKeyHex,
    });
  }

  /** `{ v2, v1 }` — write v2, read both. */
  subjectHashes(email: string): CustomerSubjectHashes {
    return customerSubjectHashes(email, this.key);
  }
}
