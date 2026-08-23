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
import { EMAIL_PROVIDER } from './services/email-provider.interface';
import { StubEmailProvider } from './services/stub-email.provider';
import { UsersRepository } from './repositories/users.repository';
import { RefreshTokensRepository } from './repositories/refresh-tokens.repository';
import { PasswordResetTokensRepository } from './repositories/password-reset-tokens.repository';
import { SignInRateLimitGuard } from './guards/signin-rate-limit.guard';
import { PasswordResetRateLimitGuard } from './guards/password-reset-rate-limit.guard';
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
    // `useExisting` (not `useClass`) so `EMAIL_PROVIDER` and the concrete
    // `StubEmailProvider` injection token resolve to the *same* singleton
    // instance — otherwise a test injecting `StubEmailProvider` directly
    // would see a different in-memory token map than the one the worker
    // (which injects `EMAIL_PROVIDER`) actually wrote to.
    StubEmailProvider,
    { provide: EMAIL_PROVIDER, useExisting: StubEmailProvider },
    UsersRepository,
    RefreshTokensRepository,
    PasswordResetTokensRepository,
    SignInRateLimitGuard,
    PasswordResetRateLimitGuard,
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
  exports: [StubEmailProvider, UsersRepository, PlatformOwnerGuard],
})
export class IdentityModule {}
