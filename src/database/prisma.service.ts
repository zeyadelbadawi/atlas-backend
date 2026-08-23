/**
 * PrismaService — the one Prisma client instance the app shares.
 *
 * Every later phase's repository classes inject this rather than
 * constructing their own `PrismaClient` — one connection pool, one place
 * query logging is configured, matching the master plan §11's
 * `Repository / Data Access` layer.
 *
 * Row-Level Security (master plan §7, Phase P2): connects using
 * `APP_DATABASE_URL` (a non-superuser, non-BYPASSRLS role), never
 * `DATABASE_URL` (the Prisma-CLI/migration superuser role). This is not
 * cosmetic — Postgres never applies row security to a superuser
 * connection, so if this service connected with the superuser credential,
 * every RLS policy in the schema would be silently inert regardless of how
 * correctly `TenancyContextService` sets the session variable. See
 * `prisma/migrations/20260823183500_p2_app_role_rls_enforcement` for the
 * role this connects as and why it exists. Setting the per-request
 * `app.current_organization_id`/`app.current_user_id` session variables
 * this role's RLS policies read is `TenancyContextService`'s job — this
 * class only owns the connection itself.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import type { DatabaseConfig } from '../config/configuration';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(configService: ConfigService) {
    const database = configService.get<DatabaseConfig>('database');
    super({
      datasources: { db: { url: database?.appUrl } },
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma's event typings are generic-parameter-dependent; narrowing here would require re-declaring the client's full generic signature for no behavioral gain.
    (this as any).$on('warn', (event: unknown) => this.logger.warn(event));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).$on('error', (event: unknown) => this.logger.error(event));

    await this.$connect();
    this.logger.log('Database connection established.');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Used by the health check — a real round-trip, not just "is the client object constructed." */
  async isHealthy(): Promise<boolean> {
    await this.$queryRaw`SELECT 1`;
    return true;
  }
}
