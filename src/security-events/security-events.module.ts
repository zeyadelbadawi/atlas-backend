/**
 * SecurityEventsModule — W3: the `security_events` writer.
 *
 * `@Global()`, like `AuditLogModule`: a leaf every authentication path
 * (identity's OTP and account-deletion services, the sign-in limiter)
 * records into without an `imports` edge — `IdentityModule` is imported BY
 * the modules that would otherwise have to import this one, and the
 * explicit edge would close a cycle. It imports nothing itself.
 *
 * The Platform Owner's read side (controller, aggregates, retention sweep)
 * lives in `SecurityMonitoringModule`.
 */
import { Global, Module } from '@nestjs/common';
import { SecurityEventHasher } from './services/security-event-hasher.service';
import { SecurityEventsService } from './services/security-events.service';

@Global()
@Module({
  providers: [SecurityEventHasher, SecurityEventsService],
  exports: [SecurityEventHasher, SecurityEventsService],
})
export class SecurityEventsModule {}
