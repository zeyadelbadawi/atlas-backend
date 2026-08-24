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
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
import { CoursesController } from './controllers/courses.controller';
import { CourseCurriculumController } from './controllers/course-curriculum.controller';
import { CoursesService } from './services/courses.service';
import { CourseCurriculumService } from './services/course-curriculum.service';
import { CoursesRepository } from './repositories/courses.repository';
import { CourseCategoriesRepository } from './repositories/course-categories.repository';
import { CourseSectionsRepository } from './repositories/course-sections.repository';
import { CourseLessonsRepository } from './repositories/course-lessons.repository';

@Module({
  imports: [AuthCoreModule, TenancyModule, AcademyModule],
  controllers: [CoursesController, CourseCurriculumController],
  providers: [
    CoursesService,
    CourseCurriculumService,
    CoursesRepository,
    CourseCategoriesRepository,
    CourseSectionsRepository,
    CourseLessonsRepository,
  ],
  exports: [CoursesRepository, CourseSectionsRepository, CourseLessonsRepository],
})
export class CourseModule {}
