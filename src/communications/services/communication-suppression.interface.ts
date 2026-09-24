/**
 * Suppression lookup — P64 Communications C0. The real implementation
 * (hashed addresses fed by provider webhooks) ships with the provider
 * registry; this module only depends on the shape and binds a no-op by
 * default so the dispatcher never mails an address it was told not to
 * once the real service is bound.
 */
export interface CommunicationSuppressionLookup {
  /** `true` when the address must not be mailed. */
  isSuppressed(email: string): Promise<boolean>;
}

export const COMMUNICATION_SUPPRESSION = Symbol('COMMUNICATION_SUPPRESSION');

export class NoopCommunicationSuppression implements CommunicationSuppressionLookup {
  async isSuppressed(): Promise<boolean> {
    return false;
  }
}
