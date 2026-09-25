/**
 * IdentityModule — Phase P1 (master plan §21), extended in Phase P2 to
 * populate real organization data on `CurrentUser` (§21 Phase P2).
 *
 * Imports `TenancyModule` for `UserOrganizationsService` — a one-directional
 * dependency (identity needs tenancy, never the reverse); see
 * `AuthCoreModule`'s doc comment for why `JwtAuthGuard`/`AccessTokenService`
 * live in their own module instead of creating a cycle here.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from './auth-core.module';
import { AuthController } from './controllers/auth.controller';
import { UsersController } from './controllers/users.controller';
import { AuthService } from './services/auth.service';
import { UsersService } from './services/users.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { AuthRateLimiterService } from './services/auth-rate-limiter.service';
import { CommunicationsProvidersModule } from '../communications/communications-providers.module';
import { UsersRepository } from './repositories/users.repository';
import { RefreshTokensRepository } from './repositories/refresh-tokens.repository';
import { PasswordResetTokensRepository } from './repositories/password-reset-tokens.repository';
import { EmailVerificationTokensRepository } from './repositories/email-verification-tokens.repository';
import { EmailRiskService } from './services/email-risk.service';
import { AccountDeletionService } from './services/account-deletion.service';
import { TwoFactorService } from './services/two-factor.service';
import { TotpSecretCipher } from './services/totp-secret-cipher.service';
import { TwoFactorController } from './controllers/two-factor.controller';
import { SignInRateLimitGuard } from './guards/signin-rate-limit.guard';
import { PasswordResetRateLimitGuard } from './guards/password-reset-rate-limit.guard';
import { RegisterRateLimitGuard } from './guards/register-rate-limit.guard';
import { PlatformOwnerGuard } from './guards/platform-owner.guard';
import { PasswordResetEmailProducer } from './queue/password-reset-email.producer';
import { PasswordResetEmailProcessor } from './queue/password-reset-email.processor';
import { PASSWORD_RESET_EMAIL_QUEUE } from './queue/password-reset-email.types';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CERTIFICATE_JOBS_QUEUE } from '../certificates/queue/certificate-jobs.types';
import { AcademySurfaceService } from './services/academy-surface.service';
import { EmailOtpService } from './services/email-otp.service';
import { TrustedDeviceService } from './services/trusted-device.service';
import { AuthChallengeCipher } from './services/auth-challenge-cipher.service';
import { EmailOtpController } from './controllers/email-otp.controller';
import { TrustedDevicesController } from './controllers/trusted-devices.controller';

@Module({
  imports: [
    AuthCoreModule,
    BullModule.registerQueue({ name: PASSWORD_RESET_EMAIL_QUEUE }),
    // P64 Phase 3 — account deletion enqueues certificate anonymisation.
    BullModule.registerQueue({ name: CERTIFICATE_JOBS_QUEUE }),
    // One-directional: identity needs `UserOrganizationsService` to
    // populate `CurrentUser.organizations`. `TenancyModule` itself only
    // depends on `AuthCoreModule` (never on `IdentityModule`), so this
    // stays a clean DAG — no `forwardRef` needed.
    TenancyModule,
    // P64 Communications — adapters, registry, quota, suppression, webhook.
    CommunicationsProvidersModule,
  ],
  // `TwoFactorController` is listed before `AuthController` so its
  // `/auth/2fa/*` routes are registered ahead of any broader `/auth/*`
  // pattern — Nest matches in declaration order. P64 C4's two controllers
  // join it ahead of `AuthController` for the same reason.
  controllers: [
    TwoFactorController,
    EmailOtpController,
    TrustedDevicesController,
    AuthController,
    UsersController,
  ],
  providers: [
    AuthService,
    UsersService,
    AcademySurfaceService,
    PasswordHasherService,
    AuthRateLimiterService,
    // P64 Communications — `EMAIL_PROVIDER` now resolves to
    // `EmailProviderRegistry` (Brevo primary → Resend fallback, or the stub
    // in dev/test), provided by `CommunicationsProvidersModule` and
    // re-exported below so every existing injection site is unchanged.
    UsersRepository,
    RefreshTokensRepository,
    PasswordResetTokensRepository,
    EmailVerificationTokensRepository,
    EmailRiskService,
    AccountDeletionService,
    TwoFactorService,
    TotpSecretCipher,
    // P64 Communications C4 — the emailed-code step and the trusted
    // browsers that let it be skipped. `CommunicationService` and
    // `AuditLogWriterService` come from their own `@Global()` modules, so
    // no new import is needed here.
    AuthChallengeCipher,
    EmailOtpService,
    TrustedDeviceService,
    SignInRateLimitGuard,
    PasswordResetRateLimitGuard,
    RegisterRateLimitGuard,
    PlatformOwnerGuard,
    PasswordResetEmailProducer,
    PasswordResetEmailProcessor,
  ],
  // `StubEmailProvider` — integration/e2e tests inject the concrete class
  // directly (`peekLastPasswordResetToken`), not the DI token.
  // `UsersRepository` — `PlatformOwnerGuard` lives here (it's fundamentally
  // an identity/user-attribute check, not a tenancy one) and needs it.
  // `PlatformOwnerGuard` — exported for Phase P15 to apply to its own
  // routes; unattached to any route in P2 itself (master plan §21 P2:
  // "P2 only wires the flag... P15 can use it").
  // `EMAIL_PROVIDER` — Phase P17's `EmailService`
  // (`src/notification-events/services/email.service.ts`) needs the same
  // resolved provider `PasswordResetEmailProcessor` already injects, not
  // a second `useFactory` resolution elsewhere.
  // `PasswordHasherService` — exported as of the Organization Manager
  // phase's Instructor/Student additions: `AcademiesService.addInstructor`/
  // `createStudent` need to hash a password when creating a brand-new
  // account directly (the same reasoning `UsersRepository`'s own export
  // note already documents for admin-initiated account creation without
  // an invitation/email system).
  exports: [
    // P64 Communications — `EMAIL_PROVIDER` and `StubEmailProvider` now come
    // from `CommunicationsProvidersModule`; Nest re-exports at module
    // granularity, so the whole module is exported (its own export list is
    // deliberately small: token, registry, stub, quota, suppression, producer).
    CommunicationsProvidersModule,
    UsersRepository,
    PlatformOwnerGuard,
    PasswordHasherService,
    // P64 Phase 2 — the learner surface scopes every read by the academy
    // the request HOST resolved to, and this is the service that resolves
    // it. Exported rather than duplicated so "which academy is this host"
    // keeps exactly one definition, shared with the Phase 1 sign-in path.
    AcademySurfaceService,
    // Invitation CREATION reuses the SAME address-trust gate as sign-up
    // (`AuthService.register`): the invited email must clear the disposable
    // and deliverability checks before an invite is bound to it. Exported
    // so `AcademyStudentsService` shares this one instance rather than
    // standing up a second, weaker "email validator".
    EmailRiskService,
    // P64 Communications C4 — `AccountDeletionService` and the session
    // surfaces in other modules need to forget a person's trusted
    // browsers; exported so there is one instance of this policy rather
    // than a second, weaker "forget devices" somewhere else.
    TrustedDeviceService,
  ],
})
export class IdentityModule {}
