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
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CourseModule } from '../course/course.module';
import { CourseDiscoveryController } from './controllers/course-discovery.controller';
import { EnrollmentsController } from './controllers/enrollments.controller';
import { CourseProgressController } from './controllers/course-progress.controller';
import { QuizzesController } from './controllers/quizzes.controller';
import { AssignmentsController } from './controllers/assignments.controller';
import { CourseDiscoveryService } from './services/course-discovery.service';
import { EnrollmentsService } from './services/enrollments.service';
import { CourseProgressService } from './services/course-progress.service';
import { QuizzesService } from './services/quizzes.service';
import { AssignmentsService } from './services/assignments.service';
import { EnrollmentsRepository } from './repositories/enrollments.repository';
import { CourseProgressRepository } from './repositories/course-progress.repository';
import { QuizzesRepository } from './repositories/quizzes.repository';
import { AssignmentsRepository } from './repositories/assignments.repository';

@Module({
  imports: [AuthCoreModule, TenancyModule, CourseModule],
  controllers: [
    CourseDiscoveryController,
    EnrollmentsController,
    CourseProgressController,
    QuizzesController,
    AssignmentsController,
  ],
  providers: [
    CourseDiscoveryService,
    EnrollmentsService,
    CourseProgressService,
    QuizzesService,
    AssignmentsService,
    EnrollmentsRepository,
    CourseProgressRepository,
    QuizzesRepository,
    AssignmentsRepository,
  ],
  exports: [EnrollmentsService, EnrollmentsRepository],
})
export class LearningModule {}
