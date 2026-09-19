/**
 * `FlagsModule` — the P64 Phase 2 rollout flags, shared.
 *
 * A module of its own because both `MediaModule` (which must refuse video
 * uploads until `video.stream` is on for the academy) and `LearningModule`
 * (which decides whether the curriculum still emits `contentUrl`) ask the
 * same questions, and neither should have to import the other to do it.
 *
 * Holds no state and touches no database: `FeatureFlagsService` reads
 * configuration only.
 */
import { Module } from '@nestjs/common';
import { FeatureFlagsService } from './feature-flags.service';

@Module({
  providers: [FeatureFlagsService],
  exports: [FeatureFlagsService],
})
export class FlagsModule {}
