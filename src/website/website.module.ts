/**
 * WebsiteModule — Phases P9/P10 (master plan §21). Wires the Website
 * Builder & Theme Engine surface (P9: `WebsiteConfigurationService`/
 * `WebsitePagesService`) and the CMS Content Library (P10:
 * `WebsiteContentService`, FAQ/Testimonial entries), plus the shared
 * `SectionReferenceValidatorService` both depend on.
 *
 * Imports `AuthCoreModule` (for `JwtAuthGuard`), `TenancyModule` (for
 * `TenancyContextService`), `AcademyModule` (for `AcademyScopeGuard` and
 * `AcademyMembersRepository`, reused verbatim, unmodified), and
 * `CourseModule` (for `CoursesRepository`, reused verbatim to validate
 * `courseId` references without duplicating course-management logic —
 * never a new course query, never a parallel course projection). No new
 * guard, no new session variable, no new tenant mechanism.
 *
 * `src/website/seo/` (SEO resolution + structured-data builders, P10) is
 * deliberately NOT wired here — those are pure, dependency-free utility
 * functions with no controller/service/DI presence at all (no HTTP
 * endpoint exists for them in the real frontend contract; see
 * `seo-resolution.util.ts`'s doc comment), imported directly wherever a
 * future caller (P11) needs them.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
import { CourseModule } from '../course/course.module';
import { WebsiteController } from './controllers/website.controller';
import { WebsiteContentController } from './controllers/website-content.controller';
import { WebsiteConfigurationService } from './services/website-configuration.service';
import { WebsitePagesService } from './services/website-pages.service';
import { WebsiteContentService } from './services/website-content.service';
import { WebsiteBootstrapService } from './services/website-bootstrap.service';
import { SectionReferenceValidatorService } from './services/section-reference-validator.service';
import { WebsiteConfigurationRepository } from './repositories/website-configuration.repository';
import { WebsitePagesRepository } from './repositories/website-pages.repository';
import { WebsiteFaqEntriesRepository } from './repositories/website-faq-entries.repository';
import { WebsiteTestimonialEntriesRepository } from './repositories/website-testimonial-entries.repository';

@Module({
  imports: [AuthCoreModule, TenancyModule, AcademyModule, CourseModule],
  controllers: [WebsiteController, WebsiteContentController],
  providers: [
    WebsiteConfigurationService,
    WebsitePagesService,
    WebsiteContentService,
    WebsiteBootstrapService,
    SectionReferenceValidatorService,
    WebsiteConfigurationRepository,
    WebsitePagesRepository,
    WebsiteFaqEntriesRepository,
    WebsiteTestimonialEntriesRepository,
  ],
  // `WebsiteConfigurationRepository`/`WebsitePagesRepository` exported so
  // `PublicWebsiteModule` (P11) can reuse their real published-only query
  // methods (`findPublishedByAcademyId`/`findAllPublished`/
  // `findPublishedBySlug`) directly — never a duplicated query against the
  // same tables. `WebsiteConfigurationService` additionally exported as
  // of Phase P19, so `ProvisioningModule`'s orchestrator can call its
  // real `updateConfiguration` (the theme-selection provisioning step)
  // rather than re-implementing theme persistence a second time.
  exports: [
    WebsiteConfigurationRepository,
    WebsitePagesRepository,
    WebsiteConfigurationService,
  ],
})
export class WebsiteModule {}
