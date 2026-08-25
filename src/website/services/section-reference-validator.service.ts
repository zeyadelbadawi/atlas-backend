/**
 * SectionReferenceValidatorService — validates every `courseId`/`pageId`/
 * FAQ-and-Testimonial-`libraryEntryIds` embedded in a website payload
 * against the REAL, academy-scoped data, never trusted at face value.
 *
 * Course references reuse `CoursesRepository` (exported from `CourseModule`,
 * P5) directly — never a duplicated course-existence query — and enforce
 * academy-scoped ownership explicitly (`course.academyId === academyId`),
 * since `CoursesRepository.findById` itself takes no academy scope. Page
 * references are checked against this Academy's own `website_pages` rows.
 * FAQ/Testimonial library references (master plan §21 P10; P9 deliberately
 * left these unresolved since the P10 tables did not exist yet — see
 * `FaqSectionConfig.libraryEntryIds`/`TestimonialsSectionConfig.
 * libraryEntryIds`, `website-section.types.ts`) are checked the identical
 * way: existence + academy ownership, via the same
 * `WebsiteFaqEntriesRepository`/`WebsiteTestimonialEntriesRepository`
 * `findAllForAcademy` this file already reuses for page references —
 * never a duplicated query, never a new reference model. No `status`
 * filter is applied here: direct inspection of the real frontend
 * (`SectionConfigForm.tsx`'s library-entry picker, `FaqSection.tsx`'s
 * renderer) shows the picker only ever offers `published` entries and the
 * renderer only ever resolves `published` ones — but nothing in the
 * `FaqSectionConfig`/`TestimonialsSectionConfig` Zod schema or the
 * `Update*Payload` types restricts a stored reference to `published`
 * status, and a draft entry a Tenant Owner is about to publish is a
 * legitimate, existing, real reference — exactly the same
 * "exists + academy-scoped, not status-gated" rule already established
 * for `courseId` (a section can reference a draft `Course` too). A
 * reference to an entry that never resolves at render time (not yet
 * published, or later archived) degrades gracefully to "absent," matching
 * the renderer's own `.filter((entry) => !!entry && entry.visible)`
 * behavior — never a write-time rejection.
 *
 * The Academy id validated against is always the one resolved server-side
 * by `AcademyScopeGuard` from the authenticated request — never a
 * client-supplied value anywhere in this class, which is what actually
 * prevents a cross-academy reference (master plan §21 P9/P10: "never
 * trust a client-supplied academyId").
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { WebsitePagesRepository } from '../repositories/website-pages.repository';
import { WebsiteFaqEntriesRepository } from '../repositories/website-faq-entries.repository';
import { WebsiteTestimonialEntriesRepository } from '../repositories/website-testimonial-entries.repository';
import type { ValidatedSectionInstance } from '../validation/section-config.schemas';
import type { FieldViolation } from '../../common/dto/api-error.dto';

interface CollectedReferences {
  readonly courseIds: Set<string>;
  readonly pageIds: Set<string>;
  readonly faqEntryIds: Set<string>;
  readonly testimonialEntryIds: Set<string>;
}

/** Pulls every `WebsiteCta`-shaped `{courseId?, pageId?}` pair, `featuredCourses`'s own `courseIds[]`, and every `faq`/`testimonials` section's `libraryEntryIds[]` out of a validated section array — one place that knows where each reference kind can appear in a `SectionInstance`, so a 12th section type only needs to add itself here once. */
function collectSectionReferences(
  sections: readonly ValidatedSectionInstance[],
): CollectedReferences {
  const courseIds = new Set<string>();
  const pageIds = new Set<string>();
  const faqEntryIds = new Set<string>();
  const testimonialEntryIds = new Set<string>();

  const addCta = (
    cta: { readonly courseId?: string; readonly pageId?: string } | undefined,
  ) => {
    if (cta?.courseId) courseIds.add(cta.courseId);
    if (cta?.pageId) pageIds.add(cta.pageId);
  };

  for (const section of sections) {
    switch (section.type) {
      case 'hero':
        addCta(section.config.cta);
        addCta(section.config.secondaryCta);
        break;
      case 'featuredCourses':
        (section.config.courseIds ?? []).forEach((id: string) => courseIds.add(id));
        break;
      case 'cta':
        addCta(section.config.cta);
        break;
      case 'faq':
        (section.config.libraryEntryIds ?? []).forEach((id: string) =>
          faqEntryIds.add(id),
        );
        break;
      case 'testimonials':
        (section.config.libraryEntryIds ?? []).forEach((id: string) =>
          testimonialEntryIds.add(id),
        );
        break;
      default:
        break;
    }
  }

  return { courseIds, pageIds, faqEntryIds, testimonialEntryIds };
}

@Injectable()
export class SectionReferenceValidatorService {
  constructor(
    private readonly coursesRepository: CoursesRepository,
    private readonly websitePagesRepository: WebsitePagesRepository,
    private readonly websiteFaqEntriesRepository: WebsiteFaqEntriesRepository,
    private readonly websiteTestimonialEntriesRepository: WebsiteTestimonialEntriesRepository,
  ) {}

  /** Validates every course/page/FAQ/testimonial reference found inside a page's `sections` array. */
  async validateSectionReferences(
    tx: Prisma.TransactionClient,
    academyId: string,
    sections: readonly ValidatedSectionInstance[],
  ): Promise<void> {
    const { courseIds, pageIds, faqEntryIds, testimonialEntryIds } =
      collectSectionReferences(sections);
    await this.validateReferences(tx, academyId, {
      courseIds,
      pageIds,
      faqEntryIds,
      testimonialEntryIds,
    });
  }

  /** Validates every `pageId` reference found inside `navigation`/`header`/`footer` (none of these carry `courseId`/library references — matches `WebsiteNavigationItem`/`WebsiteHeaderConfig`/`WebsiteFooterConfig`, `website.types.ts`). */
  async validateConfigurationReferences(
    tx: Prisma.TransactionClient,
    academyId: string,
    references: {
      readonly navigation?: readonly { readonly pageId: string }[];
      readonly header?: { readonly cta?: { readonly pageId?: string } };
      readonly footer?: {
        readonly groups?: readonly {
          readonly links?: readonly { readonly pageId?: string }[];
        }[];
        readonly socialLinks?: readonly { readonly pageId?: string }[];
      };
    },
  ): Promise<void> {
    const pageIds = new Set<string>();
    (references.navigation ?? []).forEach((item) => pageIds.add(item.pageId));
    if (references.header?.cta?.pageId) pageIds.add(references.header.cta.pageId);
    (references.footer?.groups ?? []).forEach((group) =>
      (group.links ?? []).forEach((link) => {
        if (link.pageId) pageIds.add(link.pageId);
      }),
    );
    (references.footer?.socialLinks ?? []).forEach((link) => {
      if (link.pageId) pageIds.add(link.pageId);
    });

    await this.validateReferences(tx, academyId, {
      courseIds: new Set(),
      pageIds,
      faqEntryIds: new Set(),
      testimonialEntryIds: new Set(),
    });
  }

  private async validateReferences(
    tx: Prisma.TransactionClient,
    academyId: string,
    references: CollectedReferences,
  ): Promise<void> {
    const { courseIds, pageIds, faqEntryIds, testimonialEntryIds } = references;
    const violations: FieldViolation[] = [];

    if (courseIds.size > 0) {
      const results = await Promise.all(
        [...courseIds].map(async (courseId) => {
          const course = await this.coursesRepository.findById(tx, courseId);
          return { courseId, valid: !!course && course.academyId === academyId };
        }),
      );
      for (const result of results) {
        if (!result.valid) {
          violations.push({
            field: `courseId:${result.courseId}`,
            messageKey: 'errors.website.courseNotFound',
          });
        }
      }
    }

    if (pageIds.size > 0) {
      const pages = await this.websitePagesRepository.findAllForAcademy(tx, academyId);
      const existingIds = new Set(pages.map((page) => page.id));
      for (const pageId of pageIds) {
        if (!existingIds.has(pageId)) {
          violations.push({
            field: `pageId:${pageId}`,
            messageKey: 'errors.website.pageNotFound',
          });
        }
      }
    }

    if (faqEntryIds.size > 0) {
      const entries = await this.websiteFaqEntriesRepository.findAllForAcademy(
        tx,
        academyId,
      );
      const existingIds = new Set(entries.map((entry) => entry.id));
      for (const faqEntryId of faqEntryIds) {
        if (!existingIds.has(faqEntryId)) {
          violations.push({
            field: `faqEntryId:${faqEntryId}`,
            messageKey: 'errors.website.faqEntryNotFound',
          });
        }
      }
    }

    if (testimonialEntryIds.size > 0) {
      const entries = await this.websiteTestimonialEntriesRepository.findAllForAcademy(
        tx,
        academyId,
      );
      const existingIds = new Set(entries.map((entry) => entry.id));
      for (const testimonialEntryId of testimonialEntryIds) {
        if (!existingIds.has(testimonialEntryId)) {
          violations.push({
            field: `testimonialEntryId:${testimonialEntryId}`,
            messageKey: 'errors.website.testimonialEntryNotFound',
          });
        }
      }
    }

    if (violations.length > 0) {
      throw new BadRequestException({
        messageKey: 'errors.validation.failed',
        violations,
      });
    }
  }
}
