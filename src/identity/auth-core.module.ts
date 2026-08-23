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
 */
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AccessTokenService } from './services/access-token.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    // `secret`/`signOptions` supplied per-call by `AccessTokenService`
    // (reads `IdentityConfig` itself) — one place owns JWT configuration.
    JwtModule.register({}),
  ],
  providers: [AccessTokenService, JwtAuthGuard],
  exports: [AccessTokenService, JwtAuthGuard],
})
export class AuthCoreModule {}
