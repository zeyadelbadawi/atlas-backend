/** Extracts the `AuthContext` `JwtAuthGuard` attached to the request. Only valid on routes guarded by `JwtAuthGuard` — anywhere else `authContext` is undefined. */
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext } from '../guards/jwt-auth.guard';

export const CurrentAuthContext = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthContext => {
    const request = ctx.switchToHttp().getRequest<Request>();
    // Non-null assertion is safe: this decorator is only ever used inside a
    // controller method also decorated with `@UseGuards(JwtAuthGuard)`,
    // which throws before the handler runs if `authContext` would be unset.
    return request.authContext!;
  },
);
