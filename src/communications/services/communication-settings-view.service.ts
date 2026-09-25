/**
 * The EFFECTIVE communication settings, read-only (cloud remediation,
 * finding G).
 *
 * The Platform Settings → Communications section and the Academy Settings
 * communication card were built against `GET/PATCH` contracts
 * (`/platform-settings/communications`,
 * `/academies/:id/communication-settings`) that the backend never
 * shipped, so both screens answered 404 in production.
 *
 * What exists today is configuration, not data: the OTP modes are the
 * `FLAG_AUTH_EMAIL_OTP_MODE_*` environment flags, trusted-device lifetimes
 * are `AUTH_TRUSTED_DEVICE_DAYS_*`, the digest hour is a constant, the
 * provider chain is `EMAIL_PROVIDERS`, and nothing stores a per-academy
 * override. Making these editable would move the sign-in second-factor
 * control plane from the deployment into the database — an architectural
 * and security decision that needs its own migration and owner approval.
 *
 * So these endpoints report exactly what is in force, marked
 * `editable: false` with `source: 'deployment'`, and the UI renders them
 * read-only. Nothing here is invented and nothing is persisted.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailConfig, IdentityConfig } from '../../config/configuration';
import { EmailProviderRegistry } from '../providers/email-provider.registry';
import { DIGEST_LOCAL_HOUR } from '../queue/communications.types';

export interface PlatformCommunicationSettingsView {
  readonly editable: false;
  readonly source: 'deployment';
  readonly emailOtpPolicyManagement: string;
  readonly emailOtpPolicyAcademyDefault: string;
  readonly trustedDeviceDaysManagement: number;
  readonly trustedDeviceDaysAcademy: number;
  readonly digestHourLocal: number;
  /** No quota-alert thresholds exist today; reported empty rather than invented. */
  readonly quotaAlertThresholds: readonly number[];
  readonly providerStatus: readonly {
    readonly order: readonly string[];
    readonly active: string | null;
    readonly fromEmail: string | null;
    readonly configured: boolean;
  }[];
}

export interface AcademyCommunicationSettingsView {
  readonly editable: false;
  readonly source: 'deployment';
  /** No per-academy override exists, so every academy inherits the platform default. */
  readonly emailOtpPolicy: 'inherit';
  readonly effectiveEmailOtpPolicy: string;
  /** The catalogue sends announcements in-app only (`email: 'never'`). */
  readonly announcementEmailAllowed: false;
  /** The engagement-digest default a learner starts with (`communication-preferences.util.ts`). */
  readonly learnerDigestDefault: 'immediate';
}

@Injectable()
export class CommunicationSettingsViewService {
  constructor(
    private readonly configService: ConfigService,
    private readonly registry: EmailProviderRegistry,
  ) {}

  platform(): PlatformCommunicationSettingsView {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const email = this.configService.getOrThrow<EmailConfig>('email');
    const order = this.registry.providerNames();
    return {
      editable: false,
      source: 'deployment',
      emailOtpPolicyManagement: identity.emailOtp.management,
      emailOtpPolicyAcademyDefault: identity.emailOtp.academy,
      trustedDeviceDaysManagement: identity.emailOtp.trustedDeviceDaysManagement,
      trustedDeviceDaysAcademy: identity.emailOtp.trustedDeviceDaysAcademy,
      digestHourLocal: DIGEST_LOCAL_HOUR,
      quotaAlertThresholds: [],
      providerStatus: [
        {
          order,
          active: order[0] ?? null,
          // A sender address, not a credential.
          fromEmail: email.fromEmail ?? null,
          configured: order.length > 0 && order[0] !== 'stub',
        },
      ],
    };
  }

  academy(): AcademyCommunicationSettingsView {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    return {
      editable: false,
      source: 'deployment',
      emailOtpPolicy: 'inherit',
      effectiveEmailOtpPolicy: identity.emailOtp.academy,
      announcementEmailAllowed: false,
      learnerDigestDefault: 'immediate',
    };
  }
}
