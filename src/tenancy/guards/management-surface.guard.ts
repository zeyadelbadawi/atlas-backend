/**
 * ManagementSurfaceGuard — P64 Phase 1 (master plan AD-5, Finding F1).
 *
 * The management dashboard is for Platform Owners, Client Owners, Managers
 * and Instructors. A LEARNER principal (only `academy_students` rows, no
 * staff fact) must never reach a management controller, no matter what the
 * frontend shows or hides — this guard is the server-side boundary, applied
 * after `JwtAuthGuard` on every management controller.
 *
 * `unaffiliated` (a brand-new account with no fact yet) passes: that is the
 * self-service Organization-Owner onboarding journey, and the SaaS-level
 * endpoints it needs already carry `SaasLevelCallerGuard`.
 *
 * 403 with a distinct message key, deliberately not 404: the caller has
 * proven who they are; what they lack is the surface, and the frontend uses
 * this key to send them to their academy website.
 *
 * The guard runs on every management controller in every configuration.
 * `SurfaceEnforcementService` decides only whether the rollout has reached
 * this learner yet (master plan Phase 1 §T); it is rollout control, never
 * the boundary, and it can never admit anyone RLS or another guard would
 * refuse.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrincipalResolverService } from '../services/principal-resolver.service';
import { SurfaceEnforcementService } from '../services/surface-enforcement.service';

@Injectable()
export class ManagementSurfaceGuard implements CanActivate {
  constructor(
    private readonly principalResolver: PrincipalResolverService,
    private readonly surfaceEnforcement: SurfaceEnforcementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.authContext?.userId;
    if (!userId) {
      throw new ForbiddenException({ messageKey: 'errors.auth.managementSurfaceOnly' });
    }

    const principal = await this.principalResolver.forRequest(request, userId);
    if (principal.kind === 'learner') {
      if (this.surfaceEnforcement.isEnforcedFor(principal)) {
        throw new ForbiddenException({ messageKey: 'errors.auth.managementSurfaceOnly' });
      }
      this.surfaceEnforcement.logBypass(userId, `${request.method} ${request.path}`);
    }
    return true;
  }
}
