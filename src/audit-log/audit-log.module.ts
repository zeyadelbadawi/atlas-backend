/**
 * AuditLogModule — Phase P15 (master plan §5.12/§21). A deliberately
 * minimal, LEAF-level module (depends on nothing but the global
 * `PrismaService`) so `AuditLogWriterService` can be injected from EVERY
 * other domain module across the entire backend — billing, course
 * commerce, provisioning, academy, identity, community, etc. — without
 * ever creating a module-DAG cycle. `@Global()` for exactly the same
 * reason `DatabaseModule` is: dozens of call sites across every prior
 * phase need this one service, and requiring each of those modules to
 * explicitly `imports: [AuditLogModule]` would be pure ceremony for a
 * service with zero configuration and zero domain-specific dependencies
 * — the same reasoning `DatabaseModule`'s own doc comment already gives
 * for `PrismaService`.
 *
 * `PlatformModule`'s own `AuditLogController`/`AuditLogService` (the
 * READ side — Platform Owner only) still explicitly imports this module
 * for `AuditLogEntriesRepository`, exactly like any other consumer.
 */
import { Global, Module } from '@nestjs/common';
import { AuditLogEntriesRepository } from './repositories/audit-log-entries.repository';
import { AuditLogWriterService } from './services/audit-log-writer.service';

@Global()
@Module({
  providers: [AuditLogEntriesRepository, AuditLogWriterService],
  exports: [AuditLogEntriesRepository, AuditLogWriterService],
})
export class AuditLogModule {}
