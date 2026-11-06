/**
 * CourseCompletionRecomputeQueueModule — the `course-completion-recompute`
 * queue registration and its producer, and nothing else.
 *
 * Its own module because the producer is needed on BOTH sides of the
 * `LearningModule → CourseModule` edge: quiz/assignment authoring and the
 * completion rule live in `LearningModule`, unit deletion and unit
 * attach/detach in `CourseModule`, and `CourseModule` must not import
 * `LearningModule` (that would close the cycle). Both import this module;
 * it imports nothing of either. The ONE processor stays in
 * `LearningModule`, because it needs `CourseCompletionService`.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { COURSE_COMPLETION_RECOMPUTE_QUEUE } from './course-completion-recompute.types';
import { CourseCompletionRecomputeProducer } from './course-completion-recompute.producer';

@Module({
  imports: [BullModule.registerQueue({ name: COURSE_COMPLETION_RECOMPUTE_QUEUE })],
  providers: [CourseCompletionRecomputeProducer],
  exports: [CourseCompletionRecomputeProducer],
})
export class CourseCompletionRecomputeQueueModule {}
