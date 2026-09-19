/**
 * Per-academy rollout flags for P64 Phase 2 (master plan Phase 2 §S/§T).
 *
 * Phase 2 changes what a learner sees, where they see it and how content
 * is delivered, all at once, for every academy on the platform. The plan
 * therefore asks for a canary — an internal academy first, then the first
 * customer academy that asked for protection, a week each — and for
 * rollback to be "flag off", with no redeploy.
 *
 * This is deliberately the SAME shape `SurfaceEnforcementService` already
 * proved in Phase 1: three modes (`off` / `allowlist` / `on`), read from
 * configuration only, defaulting to the SAFE end. Reusing a reviewed
 * mechanism rather than inventing a second one means there is one place
 * to reason about how a rollout control can be abused, and the answer is
 * the same for both: it cannot, because nothing a caller sends — no
 * header, no query parameter, no token claim — reaches it.
 *
 * WHICH END IS "SAFE" DIFFERS PER FLAG, and that is the one thing worth
 * reading carefully:
 *
 *   - `content.protected` defaults to `off`. It changes the WIRE SHAPE of
 *     the curriculum response (dropping `contentUrl`), and the previous
 *     frontend image still reads that field. Defaulting it on would break
 *     every client that has not deployed yet — Phase 2 §T's "the previous
 *     image runs against the new schema" requires the opposite.
 *   - `video.normal` and `video.premium` default to `off`, and are
 *     SEPARATE flags because the two tiers roll out on different
 *     schedules (D10/DL-19): Normal depends on nothing new and canaries
 *     first, Premium waits for provider onboarding, which §S forbids
 *     skipping.
 *   - `devices.policy` defaults to `off`: it is a restriction on real
 *     learners, and switching it on globally without a canary is exactly
 *     what the canary exists to prevent.
 *
 * NONE OF THESE IS A SECURITY BOUNDARY. `content.protected` being `off`
 * does not make protected content readable — `lesson_contents` has no
 * public RLS policy either way, and `LessonContentService` checks all
 * seven conditions either way. What the flag governs is whether the OLD
 * `contentUrl` field is still emitted alongside the new grant path.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FeatureFlagConfig, LearningFeatureFlags } from '../../config/configuration';

export type LearningFeatureFlagKey = keyof LearningFeatureFlags;

@Injectable()
export class FeatureFlagsService {
  constructor(private readonly configService: ConfigService) {}

  private flag(key: LearningFeatureFlagKey): FeatureFlagConfig {
    const flags = this.configService.get<LearningFeatureFlags>('learningFeatureFlags');
    // An unreadable configuration resolves to `off`, which for every flag
    // here is the pre-Phase-2 behaviour — never a half-enabled state.
    return flags?.[key] ?? { mode: 'off', academyIds: [] };
  }

  isEnabledForAcademy(key: LearningFeatureFlagKey, academyId: string | null): boolean {
    const { mode, academyIds } = this.flag(key);
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return academyId !== null && academyIds.includes(academyId);
  }

  /** For the readiness endpoint and the Phase Completion Record — never for a decision. */
  snapshot(): Record<LearningFeatureFlagKey, FeatureFlagConfig> {
    return {
      contentProtected: this.flag('contentProtected'),
      videoNormal: this.flag('videoNormal'),
      videoPremium: this.flag('videoPremium'),
      devicesPolicy: this.flag('devicesPolicy'),
      learnerDashboardV2: this.flag('learnerDashboardV2'),
      playerV2: this.flag('playerV2'),
    };
  }
}
