/** Extracts the `TenantContext` `OrganizationMembershipGuard` attached to the request. Only valid on routes guarded by it. */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '../guards/organization-membership.guard';

export const CurrentTenantContext = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): TenantContext => {
    const request = ctx.switchToHttp().getRequest<Request>();
    return request.tenantContext!;
  },
);
