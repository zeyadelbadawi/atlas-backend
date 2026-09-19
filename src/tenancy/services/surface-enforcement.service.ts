/**
 * SurfaceEnforcementService — P64 Phase 1 (master plan Phase 1 §T).
 *
 * Answers one question: is the management-surface refusal switched ON for
 * THIS principal right now? That is a ROLLOUT question, not a security
 * one, and the distinction matters enough to state plainly:
 *
 *   - `ManagementSurfaceGuard` is the boundary. It runs on every
 *     management controller in every mode, and it is what asks this
 *     service; the service never runs on its own.
 *   - RLS is the independent second boundary. Nothing here touches it. A
 *     learner admitted to the surface while the flag is `off` still sees
 *     only their own rows, still cannot read another tenant, and still
 *     fails every other authorization check exactly as before P64.
 *   - Therefore `off` does not "grant" a learner anything. It restores the
 *     pre-P64 surface behaviour — a learner reaching the dashboard shell
 *     and the endpoints their own data allows — which is precisely what a
 *     staged rollout and an instant rollback need.
 *
 * The answer comes from configuration alone. Nothing a caller sends — no
 * header, no query parameter, no token claim — can change it, so the flag
 * cannot be used as an attack surface of its own.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  SurfaceEnforcementConfig,
  SurfaceEnforcementMode,
} from '../../config/configuration';
import type { Principal } from './principal-resolver.service';

@Injectable()
export class SurfaceEnforcementService {
  private readonly logger = new Logger(SurfaceEnforcementService.name);

  constructor(private readonly configService: ConfigService) {}

  private config(): SurfaceEnforcementConfig {
    return (
      this.configService.get<SurfaceEnforcementConfig>('surfaceEnforcement') ?? {
        mode: 'on',
        academyIds: [],
      }
    );
  }

  get mode(): SurfaceEnforcementMode {
    return this.config().mode;
  }

  /**
   * Whether the surface refusal applies to this principal.
   *
   * Only ever asked about a `learner` — every other kind is management
   * capable by definition, and the caller checks that first. Under
   * `allowlist` a learner is refused as soon as ANY academy they belong to
   * is listed: the academy that opted into the rollout gets the new
   * behaviour for its own learners, which is what "internal academy first"
   * means, and a learner of two academies is never left in a state where
   * one academy's rollout silently depends on the other's.
   */
  isEnforcedFor(principal: Pick<Principal, 'academies'>): boolean {
    const { mode, academyIds } = this.config();
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return principal.academies.some((academy) => academyIds.includes(academy.academyId));
  }

  /**
   * Records that a learner was let through because the rollout has not
   * reached them. Deliberately `warn`: while the flag is anything but
   * `on`, every one of these lines is a learner on a surface the finished
   * system refuses, and an operator should be able to see that happening
   * and see it stop when the rollout completes.
   */
  logBypass(userId: string, controller: string): void {
    this.logger.warn(
      { userId, controller, mode: this.mode },
      'Management-surface refusal not applied to a learner: surface.enforce rollout has not reached them.',
    );
  }
}
