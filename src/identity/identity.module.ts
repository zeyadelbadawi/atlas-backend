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
import { ConfigService } from '@nestjs/config';
import { AuthCoreModule } from './auth-core.module';
import { AuthController } from './controllers/auth.controller';
import { UsersController } from './controllers/users.controller';
import { AuthService } from './services/auth.service';
import { UsersService } from './services/users.service';
import { PasswordHasherService } from './services/password-hasher.service';
import { AuthRateLimiterService } from './services/auth-rate-limiter.service';
import { EMAIL_PROVIDER } from './services/email-provider.interface';
import { StubEmailProvider } from './services/stub-email.provider';
import { ResendEmailProvider } from './services/resend-email.provider';
import type { EmailConfig } from '../config/configuration';
import { UsersRepository } from './repositories/users.repository';
import { RefreshTokensRepository } from './repositories/refresh-tokens.repository';
import { PasswordResetTokensRepository } from './repositories/password-reset-tokens.repository';
import { SignInRateLimitGuard } from './guards/signin-rate-limit.guard';
import { PasswordResetRateLimitGuard } from './guards/password-reset-rate-limit.guard';
import { RegisterRateLimitGuard } from './guards/register-rate-limit.guard';
import { PlatformOwnerGuard } from './guards/platform-owner.guard';
import { PasswordResetEmailProducer } from './queue/password-reset-email.producer';
import { PasswordResetEmailProcessor } from './queue/password-reset-email.processor';
import { PASSWORD_RESET_EMAIL_QUEUE } from './queue/password-reset-email.types';
import { TenancyModule } from '../tenancy/tenancy.module';

@Module({
  imports: [
    AuthCoreModule,
    BullModule.registerQueue({ name: PASSWORD_RESET_EMAIL_QUEUE }),
    // One-directional: identity needs `UserOrganizationsService` to
    // populate `CurrentUser.organizations`. `TenancyModule` itself only
    // depends on `AuthCoreModule` (never on `IdentityModule`), so this
    // stays a clean DAG — no `forwardRef` needed.
    TenancyModule,
  ],
  controllers: [AuthController, UsersController],
  providers: [
    AuthService,
    UsersService,
    PasswordHasherService,
    AuthRateLimiterService,
    // Phase P17 — `EMAIL_PROVIDER` resolves to whichever concrete
    // implementation `EMAIL_PROVIDER` (the env var) selects, decided once
    // at DI-container build time via `useFactory` (never re-read per
    // call). Both concrete providers are still registered unconditionally
    // (cheap — `ResendEmailProvider` does nothing at construction time,
    // only when actually called) so a test can keep injecting
    // `StubEmailProvider` directly (`peekLastPasswordResetToken`/
    // `peekLastTransactionalEmail`) and see the exact same singleton the
    // token resolves to whenever `EMAIL_PROVIDER=stub` (the default —
    // matches every test/dev environment today), the same "one singleton,
    // never two divergent instances" guarantee the previous `useExisting`
    // wiring already established.
    StubEmailProvider,
    ResendEmailProvider,
    {
      provide: EMAIL_PROVIDER,
      useFactory: (
        configService: ConfigService,
        stub: StubEmailProvider,
        resend: ResendEmailProvider,
      ) => {
        const email = configService.getOrThrow<EmailConfig>('email');
        return email.provider === 'resend' ? resend : stub;
      },
      inject: [ConfigService, StubEmailProvider, ResendEmailProvider],
    },
    UsersRepository,
    RefreshTokensRepository,
    PasswordResetTokensRepository,
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
  exports: [StubEmailProvider, UsersRepository, PlatformOwnerGuard, EMAIL_PROVIDER],
})
export class IdentityModule {}
