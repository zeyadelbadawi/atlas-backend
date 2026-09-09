/**
 * AuthCoreModule — the dependency-free half of authentication:
 * `AccessTokenService` (JWT sign/verify) and `JwtAuthGuard` (the guard
 * every protected route in every module uses).
 *
 * Extracted out of `IdentityModule` specifically to break a circular
 * module dependency introduced by Phase P2: `IdentityModule` needs
 * `TenancyModule`'s `UserOrganizationsService` to populate real
 * `CurrentUser.organizations` data, and `TenancyModule`'s
 * `OrganizationsController` needs `JwtAuthGuard` to authenticate its
 * routes. Neither of those two facts should require `IdentityModule` and
 * `TenancyModule` to depend on each other — `AuthCoreModule` has zero
 * dependencies on either (only `ConfigService`), so both can import it
 * independently and the module graph stays a clean DAG:
 * `AuthCoreModule ← IdentityModule`, `AuthCoreModule ← TenancyModule`,
 * `TenancyModule ← IdentityModule` (one direction only).
 *
 * Phase 10 added `SessionRevocationService` (and the
 * `RefreshTokensRepository` it falls back to) here rather than in
 * `IdentityModule`, because `JwtAuthGuard` — which lives here and is
 * consumed by every module — now depends on it to reject revoked
 * sessions. Both dependencies keep this module dependency-free in the
 * sense that matters: `PrismaModule` and `RedisModule` are both
 * `@Global()`, so nothing new is imported and the DAG above is
 * unchanged. `IdentityModule` continues to provide its own
 * `RefreshTokensRepository` instance for its own use; these are stateless
 * repositories over a shared client, so a second instance is not a second
 * source of truth.
 */
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessTokenService } from './services/access-token.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { SessionRevocationService } from './services/session-revocation.service';
import { RefreshTokensRepository } from './repositories/refresh-tokens.repository';

@Module({
  imports: [
    // `secret`/`signOptions` supplied per-call by `AccessTokenService`
    // (reads `IdentityConfig` itself) — one place owns JWT configuration.
    JwtModule.register({}),
  ],
  providers: [
    AccessTokenService,
    JwtAuthGuard,
    SessionRevocationService,
    RefreshTokensRepository,
  ],
  exports: [AccessTokenService, JwtAuthGuard, SessionRevocationService],
})
export class AuthCoreModule {}
