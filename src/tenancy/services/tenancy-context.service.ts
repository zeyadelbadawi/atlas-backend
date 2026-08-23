/**
 * TenancyContextService — establishes the PostgreSQL RLS session variable
 * for exactly the duration of one transaction (master plan §7, §21 Phase
 * P2: "the tenant-context session-variable mechanism").
 *
 * `SET LOCAL app.current_organization_id = '<uuid>'` is set via
 * `set_config(name, value, is_local)` rather than a literal `SET LOCAL`
 * statement — Postgres's `SET` command does not accept query parameters
 * (`$1` placeholders), only the `set_config()` *function* does, so this is
 * the only way to bind `organizationId` safely instead of string-
 * interpolating it into raw SQL. `is_local = true` gives identical
 * transaction-scoped semantics to `SET LOCAL`.
 *
 * Why this is request/transaction-safe by construction, not by discipline:
 * every call opens its own Postgres transaction via `prisma.$transaction`;
 * `SET LOCAL`/`set_config(..., true)` is undone automatically when that
 * transaction commits or rolls back, and is invisible to any other
 * concurrent transaction on a different pooled connection. There is no
 * global mutable variable anywhere in this class — nothing here could leak
 * one request's tenant context into another's.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class TenancyContextService {
  constructor(private readonly prisma: PrismaService) {}

  async runInTenantContext<T>(
    organizationId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true)`;
      return work(tx);
    });
  }

  /**
   * Sets `app.current_user_id` instead of an organization context — for the
   * one class of query that is legitimately scoped by user rather than by
   * any single tenant: "which organizations does this user belong to"
   * (`CurrentUser.organizations`/`.organizationMemberships`, master plan
   * §21 Phase P2). Backed by the `organizations_member_select`/
   * `organization_memberships_self_select` RLS policies — see
   * `prisma/migrations/20260823182500_p2_self_membership_rls_policies` for
   * why a second session variable is necessary rather than reusing
   * `app.current_organization_id`.
   */
  async runInUserContext<T>(
    userId: string,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return work(tx);
    });
  }
}
