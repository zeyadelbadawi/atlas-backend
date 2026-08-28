/**
 * SearchModule — Phase P17 (master plan §21/§15): global, permission-
 * scoped full-text search. Imports `AuthCoreModule` (`JwtAuthGuard`),
 * `IdentityModule` (`UsersRepository`, to re-verify `is_platform_owner`
 * server-side), and `TenancyModule` (`TenancyContextService`/
 * `OrganizationMembershipsRepository`, to resolve the caller's real
 * organization memberships) — no coupling to any other domain module,
 * since every searchable table this phase covers
 * (`users`/`organizations`/`academies`/`courses`) is queried directly via
 * `SearchRepository`, mirroring `AnalyticsModule`'s (P16) own identical
 * "self-contained downstream leaf module" precedent.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SearchController } from './controllers/search.controller';
import { SearchService } from './services/search.service';
import { SearchRepository } from './repositories/search.repository';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule],
  controllers: [SearchController],
  providers: [SearchService, SearchRepository],
})
export class SearchModule {}
