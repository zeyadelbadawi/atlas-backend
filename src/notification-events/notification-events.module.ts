/**
 * NotificationEventsModule — Phase P17 (master plan §21). `@Global()`,
 * mirroring `AuditLogModule`'s (P15) own identical precedent exactly: a
 * small leaf module every OTHER phase's module can inject
 * `NotificationFanoutService` from without adding an `imports` entry
 * (Nest makes a `@Global()` module's exports available to every module's
 * DI container automatically) — avoiding the alternative of every caller
 * module (billing, course-commerce, provisioning, support, identity)
 * needing to import a downstream module and risk a cycle.
 *
 * Also owns `NotificationsRepository` (exported) — the single shared
 * `notifications` data-access class BOTH this module's writer AND
 * `NotificationsModule`'s read-side controller/service use, so there is
 * only ever one definition of "how to query the `notifications` table,"
 * never two.
 *
 * Needs `IdentityModule` (for `EMAIL_PROVIDER`/`UsersRepository`).
 */
import { Global, Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { NotificationsRepository } from './repositories/notifications.repository';
import { EmailService } from './services/email.service';
import { NotificationFanoutService } from './services/notification-fanout.service';

@Global()
@Module({
  imports: [IdentityModule],
  providers: [NotificationsRepository, EmailService, NotificationFanoutService],
  exports: [NotificationsRepository, NotificationFanoutService],
})
export class NotificationEventsModule {}
