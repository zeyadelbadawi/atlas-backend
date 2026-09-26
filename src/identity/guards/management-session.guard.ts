/**
 * ManagementSessionGuard — Launch Stabilization A1 (D1).
 *
 * Refuses any session that was not minted on the management surface,
 * WITHOUT the principal-kind rule `ManagementSurfaceGuard` adds. For
 * account-level actions that must never be driven from an academy website
 * (a tenant-operated origin) but are not "management work" in the RBAC
 * sense — e.g. deleting the whole global account, which also archives the
 * academies the person owns. The academy website offers no such control,
 * so nothing legitimate is refused.
 *
 * Runs after `JwtAuthGuard`, which resolves the session surface.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class ManagementSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.authContext?.surface !== 'management') {
      throw new ForbiddenException({ messageKey: 'errors.auth.managementSurfaceOnly' });
    }
    return true;
  }
}
