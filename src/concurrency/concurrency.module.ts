/**
 * Shared concurrency primitives.
 *
 * ONE mechanism for the whole product rather than one per module, which is
 * the mistake this module exists to avoid: seven editors, seven slightly
 * different notions of "stale", and six of them subtly wrong. What lives
 * here is deliberately small — an exception shape and a presence store —
 * because the parts that must be per-resource (which column holds the
 * version, who is allowed to edit) belong with that resource's own service,
 * where its authorisation already lives.
 *
 * The two halves do different jobs and only one is load-bearing:
 *
 *   - `StaleResourceVersionException` + a version column is what actually
 *     PROTECTS data. It is enforced in the database's WHERE clause.
 *   - `EditingPresenceService` is advisory. It helps humans avoid the
 *     collision in the first place, and blocks nothing.
 *
 * Presence without the version check would be theatre; the version check
 * without presence would be correct but rude.
 */
import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { EditingPresenceService } from './services/editing-presence.service';

@Module({
  imports: [RedisModule],
  providers: [EditingPresenceService],
  exports: [EditingPresenceService],
})
export class ConcurrencyModule {}
