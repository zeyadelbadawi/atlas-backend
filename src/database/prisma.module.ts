import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { IdentityResolver } from '../identity/repositories/identity-resolver';

/**
 * Global so every future domain module (P1 onward) can inject
 * `PrismaService` without each one re-importing this module — mirrors how
 * the frontend's single `apiClient` is reachable from every service without
 * per-feature wiring.
 */
@Global()
@Module({
  providers: [PrismaService, IdentityResolver],
  exports: [PrismaService, IdentityResolver],
})
export class DatabaseModule {}
