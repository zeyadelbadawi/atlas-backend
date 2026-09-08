/**
 * InstructorModule — Phase P7 (master plan §21), the "Instructor
 * Operations" half. Imports `AuthCoreModule` (`JwtAuthGuard`),
 * `TenancyModule` (`TenancyContextService`), and `CourseModule` (for
 * `CourseInstructorsRepository`, reused verbatim — the exact teaching-scope
 * source of truth `LearningModule` also reuses, per its own P7 extension).
 * No new guard, no new session variable — see `InstructorController`'s own
 * doc comment.
 *
 * Imports `AcademyModule` as of Phase 8 — `InstructorService.
 * gradeSubmission`'s new audit-log write needs `AcademiesRepository.
 * resolveOrganizationId` to resolve the grading course's real Organization
 * (this service runs entirely under `runInUserContext`, with no tenant
 * context of its own to read one from). No cycle: `AcademyModule` imports
 * only `AuthCoreModule`/`TenancyModule`/`IdentityModule`/`PlansModule` —
 * none of which import `InstructorModule`.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CourseModule } from '../course/course.module';
import { AcademyModule } from '../academy/academy.module';
import { InstructorController } from './controllers/instructor.controller';
import { InstructorService } from './services/instructor.service';
import { InstructorRepository } from './repositories/instructor.repository';

@Module({
  imports: [AuthCoreModule, TenancyModule, CourseModule, AcademyModule],
  controllers: [InstructorController],
  providers: [InstructorService, InstructorRepository],
})
export class InstructorModule {}
