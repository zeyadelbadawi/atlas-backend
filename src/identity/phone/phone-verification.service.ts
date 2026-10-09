/**
 * Phone verification — WHERE it will live, deliberately without a sender.
 *
 * Atlas has no SMS or WhatsApp provider under contract, and no genuinely
 * free, contract-free WhatsApp OTP channel exists (docs/USER_PHONE.md §6:
 * WhatsApp Business Platform bills every delivered authentication template
 * per message, per recipient country). So nothing here sends anything, and
 * the product says plainly "verification is coming soon" instead of faking
 * a verified badge.
 *
 * THE SHAPE FOR LATER. A provider adapter implements
 * `PhoneVerificationProvider` and is bound to `PHONE_VERIFICATION_PROVIDER`
 * in `IdentityModule`; `FLAG_PHONE_VERIFICATION_MODE=on` then makes
 * `availability()` report it. The verify endpoints themselves
 * (`POST /users/me/phone/verification` → code, `…/confirm`) are to be added
 * with the provider, and must:
 *   - send only to the caller's own stored, normalised number (never a number
 *     from the request body);
 *   - store only a hash of the code, single-use, short TTL, bound to the
 *     exact `phone_e164` it was sent to (a changed number voids it — the DB
 *     trigger already clears `verified_at` on any number change);
 *   - meter sends per account, per number and per IP (SMS pumping / toll
 *     fraud is the main cost risk), and attempts per code;
 *   - set `user_phones.verified_at` in the owner's own RLS context.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IdentityConfig } from '../../config/configuration';

export type PhoneVerificationChannel = 'sms' | 'whatsapp';

/** What a real SMS/WhatsApp adapter will implement. No implementation exists yet. */
export interface PhoneVerificationProvider {
  readonly channel: PhoneVerificationChannel;
  /** Delivers `code` to `e164` in the person's language. */
  sendCode(input: {
    readonly e164: string;
    readonly code: string;
    readonly language: 'en' | 'ar';
  }): Promise<void>;
}

/** Injection token for the adapter; intentionally unbound today. */
export const PHONE_VERIFICATION_PROVIDER = Symbol('PHONE_VERIFICATION_PROVIDER');

export type PhoneVerificationAvailability =
  | { readonly available: true; readonly channel: PhoneVerificationChannel }
  | {
      readonly available: false;
      /** `disabled`: the flag is off. `provider_not_configured`: on, but no adapter is bound. */
      readonly reason: 'disabled' | 'provider_not_configured';
    };

@Injectable()
export class PhoneVerificationService {
  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @Inject(PHONE_VERIFICATION_PROVIDER)
    private readonly provider?: PhoneVerificationProvider,
  ) {}

  availability(): PhoneVerificationAvailability {
    const identity = this.configService.get<IdentityConfig>('identity');
    if (identity?.phoneVerificationMode !== 'on') {
      return { available: false, reason: 'disabled' };
    }
    if (!this.provider) return { available: false, reason: 'provider_not_configured' };
    return { available: true, channel: this.provider.channel };
  }
}
