/**
 * CourseModule — Phase P5 (master plan §21). Wires the Course Management
 * authoring surface: repositories, `CoursesService`/`CourseCurriculumService`,
 * and the two controllers.
 *
 * Imports `AuthCoreModule` (for `JwtAuthGuard`), `TenancyModule` (for
 * `TenancyContextService`), and `AcademyModule` (for `AcademyScopeGuard`
 * and `AcademyMembersRepository`, both reused verbatim, unmodified) — same
 * DAG-cleanliness reasoning as every prior phase module, and the same
 * "reuse the existing tenancy backbone, never duplicate it" rule. No new
 * guard, no new session variable, no new tenant mechanism — see
 * `AcademyScopeGuard`'s own doc comment for why none was needed this
 * phase.
 *
 * Imports `PlansModule` as of Phase 2 — `CoursesService.create` needs
 * `EntitlementEnforcementService` (the live `courses` plan-limit check).
 * Module exports are not transitive in Nest, so this is imported directly
 * here even though `AcademyModule` (already imported) also depends on
 * `PlansModule` — `PlansModule` depends on neither `AcademyModule` nor
 * `CourseModule`, so this stays a clean DAG.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
import { PlansModule } from '../plans/plans.module';
import { CoursesController } from './controllers/courses.controller';
import { CourseCurriculumController } from './controllers/course-curriculum.controller';
import { CoursesService } from './services/courses.service';
import { CourseCurriculumService } from './services/course-curriculum.service';
import { CoursesRepository } from './repositories/courses.repository';
import { CourseCategoriesRepository } from './repositories/course-categories.repository';
import { CourseSectionsRepository } from './repositories/course-sections.repository';
import { CourseLessonsRepository } from './repositories/course-lessons.repository';
import { CourseInstructorsRepository } from './repositories/course-instructors.repository';

@Module({
  imports: [AuthCoreModule, TenancyModule, AcademyModule, PlansModule],
  controllers: [CoursesController, CourseCurriculumController],
  providers: [
    CoursesService,
    CourseCurriculumService,
    CoursesRepository,
    CourseCategoriesRepository,
    CourseSectionsRepository,
    CourseLessonsRepository,
    CourseInstructorsRepository,
  ],
  exports: [
    CoursesRepository,
    CourseSectionsRepository,
    CourseLessonsRepository,
    CourseInstructorsRepository,
  ],
})
export class CourseModule {}
