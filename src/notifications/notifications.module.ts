/**
 * NotificationsModule — Phase P17 (master plan §21): the user-scoped,
 * read/mark-read/preferences surface `NotificationService` (frontend)
 * calls. Imports `AuthCoreModule` (`JwtAuthGuard`), `TenancyModule`
 * (`TenancyContextService`), and `IdentityModule` (`UsersRepository`, to
 * reuse the existing `users.preferences.notifications` storage rather
 * than inventing a second preferences table — see `NotificationsService`'s
 * own doc comment).
 *
 * Deliberately distinct from the separate, `@Global()`
 * `NotificationEventsModule` (`src/notification-events/`), which owns the
 * `notifications` table's repository AND writing notifications on behalf
 * of other domains — mirrors the `AuditLogModule`/`PlatformModule` split
 * (P15) exactly: one small `@Global()` leaf module every phase can inject
 * a writer/repository from without an explicit `imports` entry (Nest
 * makes a `@Global()` module's exports available everywhere once
 * registered once in `AppModule`, the same reason `PlatformModule`
 * doesn't list `AuditLogModule` in its own `imports` either), one larger
 * downstream module owning the read-side HTTP surface.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { NotificationsController } from './controllers/notifications.controller';
import { NotificationsService } from './services/notifications.service';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
