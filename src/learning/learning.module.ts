/**
 * LearningModule — Phase P6 (master plan §21). Wires the Student Learning
 * & Assessment surface: `discoverCourses`/`discoverCourse`, enrollment,
 * course/lesson progress, quizzes (read + attempts), assignments (read +
 * submission).
 *
 * Imports `AuthCoreModule` (for `JwtAuthGuard`), `TenancyModule` (for
 * `TenancyContextService`), and `CourseModule` (for `CoursesRepository`/
 * `CourseSectionsRepository`, both reused verbatim, unmodified — the
 * discovery read-path and enrollment-time lesson-progress materialization
 * build directly on P5's own repositories rather than duplicating
 * course-table query logic). No new guard: every P6 route is
 * student-self-scoped, not academy-scoped, so `AcademyScopeGuard` does not
 * apply here at all — `JwtAuthGuard` alone is sufficient, matching
 * `PlansModule`'s catalog controllers' identical reasoning ("every
 * authenticated caller" is the entire authorization surface; the real
 * scoping happens inside each service via `TenancyContextService.
 * runInUserContext`, not a route guard).
 *
 * Reuses `app.current_user_id` — the exact session variable P2 already
 * introduced for `CurrentUser.organizations` — for every P6 query. No new
 * tenancy model, no new session variable. See `schema.prisma`'s P6 header
 * comment and the P6 migration's RLS block for the full design.
 *
 * Phase P13 addition: exports `EnrollmentsService` (for its
 * `createEnrollmentInTransaction` method) and `EnrollmentsRepository` —
 * `CourseCommerceModule` reuses both directly for paid-course enrollment
 * creation on payment success and enrollment reversal on refund, rather
 * than duplicating enrollment-materialization logic a second time.
 *
 * Imports `PlansModule` as of Phase 2 — `EnrollmentsService.createEnrollment`
 * needs `EntitlementEnforcementService` (the live `students` plan-limit
 * check). `PlansModule` depends on neither `LearningModule` nor
 * `CourseModule`, so this stays a clean DAG.
 *
 * Imports `AcademyModule` and `MediaModule` as of Phase 4 (P24). Quiz/
 * Assignment authoring (`QuizzesService`/`AssignmentsService`) needs
 * `AcademyMembersRepository` (`AcademyModule`) for
 * `assertCanAuthorCourseContent`'s Owner/Administrator/Manager check —
 * `CourseModule` (already imported) exports `CoursesRepository`/
 * `CourseInstructorsRepository` but not `AcademyMembersRepository`.
 * `AssignmentsService.uploadSubmissionAttachment` needs `MediaService`
 * (`MediaModule`) to wire real file uploads through the existing R2
 * pipeline. Neither `AcademyModule` nor `MediaModule` imports
 * `LearningModule` or `CourseModule` (both depend only on
 * `AuthCoreModule`/`TenancyModule`/`IdentityModule`/`PlansModule`), so
 * this stays a clean, acyclic DAG — no `forwardRef` needed.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CourseModule } from '../course/course.module';
import { AcademyModule } from '../academy/academy.module';
import { PlansModule } from '../plans/plans.module';
import { MediaModule } from '../media/media.module';
import { CourseDiscoveryController } from './controllers/course-discovery.controller';
import { EnrollmentsController } from './controllers/enrollments.controller';
import { CourseProgressController } from './controllers/course-progress.controller';
import { QuizzesController } from './controllers/quizzes.controller';
import { AssignmentsController } from './controllers/assignments.controller';
import { CourseReviewsController } from './controllers/course-reviews.controller';
import { CourseContentController } from './controllers/course-content.controller';
import { AcademyStudentsController } from './controllers/academy-students.controller';
import { AcademyStudentsService } from './services/academy-students.service';
import { AcademyRosterRepository } from './repositories/academy-roster.repository';
import { StudentResultsController } from './controllers/student-results.controller';
// --- P64 Phase 2 ---
import { LessonContentController } from './controllers/lesson-content.controller';
import { LearnerDashboardController } from './controllers/learner-dashboard.controller';
import { LearnerSessionController } from './controllers/learner-session.controller';
import { AcademyProtectionController } from './controllers/academy-protection.controller';
import { LessonContentService } from './services/lesson-content.service';
import { ContentGrantSigner } from './services/content-grant.signer';
import { ContentGrantRateLimiter } from './services/content-grant.rate-limiter';
import { ContentAccessLogRepository } from './repositories/content-access-log.repository';
import { CourseSequenceService } from './services/course-sequence.service';
import { PlaybackService } from './services/playback.service';
import { LearnerDashboardService } from './services/learner-dashboard.service';
import { LearnerSessionService } from './services/learner-session.service';
import { LearningLeaseService } from './services/learning-lease.service';
import { AcademyProtectionService } from './services/academy-protection.service';
import { OptionalJwtAuthGuard } from '../identity/guards/optional-jwt-auth.guard';
import { FlagsModule } from '../common/flags/flags.module';
import { RedisModule } from '../redis/redis.module';
import { IdentityModule } from '../identity/identity.module';
import { BullModule } from '@nestjs/bullmq';
import { PHASE2_MAINTENANCE_QUEUE } from './queue/phase2-maintenance.types';
import { Phase2MaintenanceScheduler } from './queue/phase2-maintenance.scheduler';
import { Phase2MaintenanceProcessor } from './queue/phase2-maintenance.processor';
import { Phase2MaintenanceService } from './services/phase2-maintenance.service';
import { CourseDiscoveryService } from './services/course-discovery.service';
import { EnrollmentsService } from './services/enrollments.service';
import { CourseProgressService } from './services/course-progress.service';
import { QuizzesService } from './services/quizzes.service';
import { AssignmentsService } from './services/assignments.service';
import { LearnerOpLedger } from './services/learner-op-ledger.service';
import { CourseReviewsService } from './services/course-reviews.service';
import { CourseContentService } from './services/course-content.service';
import { EnrollmentsRepository } from './repositories/enrollments.repository';
import { CourseProgressRepository } from './repositories/course-progress.repository';
import { QuizzesRepository } from './repositories/quizzes.repository';
import { AssignmentsRepository } from './repositories/assignments.repository';
import { CourseReviewsRepository } from './repositories/course-reviews.repository';
import { StudentResultsService } from './services/student-results.service';
import { StudentResultsRepository } from './repositories/student-results.repository';
// --- P64 Phase 3 ---
import { QuizAttemptsRepository } from './repositories/quiz-attempts.repository';
import {
  CourseCompletionRuleController,
  LearnerCompletionController,
} from './controllers/course-completion.controller';
import { QuizAttemptEngineService } from './services/quiz-attempt-engine.service';
import { CourseCompletionService } from './services/course-completion.service';
import { QuizDeadlineProducer } from './queue/quiz-deadline.producer';
import { QuizDeadlineProcessor } from './queue/quiz-deadline.processor';
import { QUIZ_DEADLINE_QUEUE } from './queue/quiz-deadline.types';
import { CERTIFICATE_JOBS_QUEUE } from '../certificates/queue/certificate-jobs.types';

@Module({
  imports: [
    AuthCoreModule,
    TenancyModule,
    CourseModule,
    AcademyModule,
    PlansModule,
    MediaModule,
    // P64 Phase 2 — the rollout flags, the lease/rate-limit store, and
    // `AcademySurfaceService` (host → academy), which the learner surface
    // scopes every read by.
    FlagsModule,
    RedisModule,
    IdentityModule,
    // P64 Phase 2 — the retention sweep (§F) and the stalled-video status
    // poll (§D.4). Both were implemented with no caller; this is what
    // makes them actually run.
    BullModule.registerQueue({ name: PHASE2_MAINTENANCE_QUEUE }),
    // P64 Phase 3 — delayed auto-submit jobs, and the certificate queue the
    // completion evaluator enqueues into (processed by CertificatesModule).
    BullModule.registerQueue({ name: QUIZ_DEADLINE_QUEUE }),
    BullModule.registerQueue({ name: CERTIFICATE_JOBS_QUEUE }),
  ],
  controllers: [
    CourseDiscoveryController,
    EnrollmentsController,
    CourseProgressController,
    QuizzesController,
    AssignmentsController,
    CourseReviewsController,
    CourseContentController,
    AcademyStudentsController,
    // Phase 9 — the student-facing "My Results" surface.
    StudentResultsController,
    // P64 Phase 2 — the learner surface: content grants, the sequence,
    // playback, the dashboard, devices/takeover, and the owner-only
    // protection settings.
    LessonContentController,
    LearnerDashboardController,
    LearnerSessionController,
    AcademyProtectionController,
    LearnerCompletionController,
    CourseCompletionRuleController,
  ],
  providers: [
    LearnerOpLedger,
    CourseDiscoveryService,
    EnrollmentsService,
    CourseProgressService,
    QuizzesService,
    AssignmentsService,
    CourseReviewsService,
    CourseContentService,
    AcademyStudentsService,
    AcademyRosterRepository,
    StudentResultsService,
    EnrollmentsRepository,
    CourseProgressRepository,
    QuizzesRepository,
    AssignmentsRepository,
    CourseReviewsRepository,
    StudentResultsRepository,
    // --- P64 Phase 2 ---
    LessonContentService,
    ContentGrantSigner,
    ContentGrantRateLimiter,
    ContentAccessLogRepository,
    CourseSequenceService,
    PlaybackService,
    LearnerDashboardService,
    LearnerSessionService,
    LearningLeaseService,
    AcademyProtectionService,
    OptionalJwtAuthGuard,
    Phase2MaintenanceService,
    Phase2MaintenanceScheduler,
    Phase2MaintenanceProcessor,
    // P64 Phase 3
    QuizAttemptsRepository,
    QuizAttemptEngineService,
    CourseCompletionService,
    QuizDeadlineProducer,
    QuizDeadlineProcessor,
  ],
  exports: [
    ContentGrantSigner,
    QuizAttemptEngineService,
    CourseCompletionService,
    QuizAttemptsRepository,
    QuizzesRepository,
    EnrollmentsService,
    EnrollmentsRepository,
    // P64 Phase 2 — `AcademyStudentsService.block` and the enrollment
    // revocation path drop a learner's lease, so the same instance has to
    // be reachable from those flows rather than a second one with its own
    // view of Redis.
    LearningLeaseService,
    LearnerSessionService,
    ContentAccessLogRepository,
  ],
})
export class LearningModule {}
