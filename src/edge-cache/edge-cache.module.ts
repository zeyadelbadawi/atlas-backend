/**
 * EdgeCacheModule — `@Global()`, like `AuditLogModule`: the purge service is
 * one queue for the whole process (so purges coalesce into few Cloudflare
 * requests), reached from every module that changes what an Academy's
 * public website shows. Imports `TenancyModule` only for
 * `TenancyContextService` (listing an Organization's Academies).
 */
import { Global, Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { EdgeCachePurgeService } from './edge-cache-purge.service';
import { PurgeAcademyEdgeCacheInterceptor } from './purge-academy-edge-cache.interceptor';

@Global()
@Module({
  imports: [TenancyModule],
  providers: [EdgeCachePurgeService, PurgeAcademyEdgeCacheInterceptor],
  exports: [EdgeCachePurgeService, PurgeAcademyEdgeCacheInterceptor],
})
export class EdgeCacheModule {}
