/**
 * CourseCurriculumService — sections and lessons: CRUD, plus the
 * full-ordering reorder model (`ReorderItemsPayload` — the frontend
 * computes the new full order client-side, from move up/down buttons or
 * drag-and-drop, and sends the complete `orderedIds` array; this service
 * validates it as an exact permutation and persists it as `order`
 * integers). Reorders lock their parent row and honour an optional
 * `expectedOrderedIds` stale check — see `curriculum-ordering.ts`.
 *
 * Every ownership-chain verification is explicit (master plan P5 §14):
 * Lesson → Section → Course → Academy → Organization. A caller must never
 * reach a child row by guessing its id under the wrong parent path.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { assertNoLearnerActivity } from './learner-activity.guard';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { CourseInstructorsRepository } from '../repositories/course-instructors.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CoursesRepository } from '../repositories/courses.repository';
import { CourseSectionsRepository } from '../repositories/course-sections.repository';
import { CourseLessonsRepository } from '../repositories/course-lessons.repository';
import { LessonContentsRepository } from '../repositories/lesson-contents.repository';
import { sanitizeRichText } from '../../communications/campaigns/rich-text-sanitizer';
import { toCourseSectionResponse } from '../dto/course-section.contract';
import type { CourseSectionResponse } from '../dto/course-section.contract';
import { toCourseLessonResponse } from '../dto/course-lesson.contract';
import { toLessonContentResponse } from '../dto/lesson-content.contract';
import type { LessonContentResponse } from '../dto/lesson-content.contract';
import type { UpsertLessonContentDto } from '../dto/upsert-lesson-content.dto';
import type { CourseLessonResponse } from '../dto/course-lesson.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import type {
  CreateCourseSectionDto,
  UpdateCourseSectionDto,
} from '../dto/course-section.dto';
import type {
  CreateCourseLessonDto,
  UpdateCourseLessonDto,
} from '../dto/course-lesson.dto';
import type { ReorderItemsDto } from '../dto/reorder-items.dto';
import {
  assertExpectedOrder,
  isExactPermutation,
  lockCourseRow,
  lockSectionRow,
  nextUnitOrder,
  persistUnitOrder,
  readUnitItems,
} from './curriculum-ordering';

/** See `AcademiesService.MANAGING_ROLES` — identical rule. */
const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

@Injectable()
export class CourseCurriculumService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly coursesRepository: CoursesRepository,
    private readonly sectionsRepository: CourseSectionsRepository,
    private readonly lessonsRepository: CourseLessonsRepository,
    private readonly lessonContentsRepository: LessonContentsRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly courseInstructorsRepository: CourseInstructorsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async getSections(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<PaginatedResult<CourseSectionResponse>> {
    const sections = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCourseInAcademy(tx, courseId, academyId);
        // P64 Phase 1 (audit finding S9) — reading a course's full
        // curriculum is an authoring-tier read, not something every member
        // of the owning organization may do. `AcademyScopeGuard` only
        // proves tenancy; this proves authority.
        await this.assertCanManage(tx, academyId, userId, courseId);
        return this.sectionsRepository.findManyForCourse(tx, courseId);
      },
    );

    const items = sections.map((section) => toCourseSectionResponse(section));
    return {
      items,
      pagination: buildPaginationMeta(1, Math.max(items.length, 1), items.length),
    };
  }

  async createSection(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: CreateCourseSectionDto,
  ): Promise<CourseSectionResponse> {
    const section = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId, courseId);
        await this.assertCourseInAcademy(tx, courseId, academyId);

        const { _max } = await this.sectionsRepository.maxOrder(tx, courseId);
        const created = await this.sectionsRepository.create(tx, {
          course: { connect: { id: courseId } },
          title: payload.title,
          description: payload.description,
          order: (_max.order ?? -1) + 1,
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course_section.created',
          targetType: 'course_section',
          targetId: created.id,
          targetLabel: created.title,
          context: { courseId },
        });

        return created;
      },
    );

    return toCourseSectionResponse({ ...section, lessons: [] });
  }

  async updateSection(
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UpdateCourseSectionDto,
  ): Promise<CourseSectionResponse> {
    const section = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId, courseId);
        await this.assertCourseInAcademy(tx, courseId, academyId);
        await this.assertSectionInCourse(tx, sectionId, courseId);

        const updated = await this.sectionsRepository.update(tx, sectionId, {
          title: payload.title,
          description: payload.description,
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course_section.updated',
          targetType: 'course_section',
          targetId: sectionId,
          targetLabel: updated.title,
          context: { courseId },
        });

        return updated;
      },
    );

    const withLessons = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.sectionsRepository.findManyForCourse(tx, courseId),
    );
    const full = withLessons.find((s) => s.id === section.id)!;
    return toCourseSectionResponse(full);
  }

  async deleteSection(
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const role = await this.assertCanManage(tx, academyId, userId, courseId);
      await this.assertCourseInAcademy(tx, courseId, academyId);
      const section = await this.assertSectionInCourse(tx, sectionId, courseId);
      // Cascades to `course_lessons` via the FK's `onDelete: Cascade` —
      // matches `CourseService.deleteCourseSection`'s own doc comment:
      // "Deletes a course section and its lessons." — and from there to
      // `lesson_progress`, so it is refused once any learner has progress
      // in it (see `learner-activity.guard.ts`). Tenant context: complete.
      await assertNoLearnerActivity(tx, { kind: 'section', id: sectionId });
      await this.sectionsRepository.delete(tx, sectionId);

      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'course_section.deleted',
        targetType: 'course_section',
        targetId: sectionId,
        targetLabel: section.title,
        context: { courseId },
      });
    });
  }

  async reorderSections(
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: ReorderItemsDto,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const role = await this.assertCanManage(tx, academyId, userId, courseId);
      await this.assertCourseInAcademy(tx, courseId, academyId);
      // Serialize concurrent section reorders of this course; every read
      // below sees what the previous writer committed (see
      // `curriculum-ordering.ts`).
      await lockCourseRow(tx, courseId);

      const existing = await tx.courseSection.findMany({
        where: { courseId },
        select: { id: true, order: true },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
      });
      const currentIds = existing.map((s) => s.id);
      assertExpectedOrder(currentIds, payload.expectedOrderedIds);
      this.assertExactPermutation(currentIds, payload.orderedIds);

      const currentOrder = new Map(existing.map((s) => [s.id, s.order]));
      for (let index = 0; index < payload.orderedIds.length; index += 1) {
        const id = payload.orderedIds[index];
        if (currentOrder.get(id) !== index) {
          await this.sectionsRepository.updateOrder(tx, id, index);
        }
      }

      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'course_section.reordered',
        targetType: 'course',
        targetId: courseId,
        context: { courseId, sectionCount: payload.orderedIds.length },
        changes: { order: { from: currentIds, to: [...payload.orderedIds] } },
      });
    });
  }

  async createLesson(
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: CreateCourseLessonDto,
  ): Promise<CourseLessonResponse> {
    // Combined tenant + user context: the append position is computed over
    // EVERY item type in the unit (quizzes/assignments carry per-user author
    // policies), not just lessons. Neither family of policy is weakened.
    const lesson = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId, courseId);
        await this.assertCourseInAcademy(tx, courseId, academyId);
        await this.assertSectionInCourse(tx, sectionId, courseId);

        // Same tenancy check the update path makes, and for the same
        // reason: an id alone proves nothing, so without this an author
        // could attach another academy's video by guessing and the grant
        // path would sign it because the lesson claims it.
        if (payload.videoAssetId) {
          await assertAttachableLessonVideo(
            tx,
            academyId,
            courseId,
            payload.videoAssetId,
          );
        }

        // Append after the LAST item of the unit across all types — the
        // unit shares one ordinal space, so "max lesson order + 1" could
        // sort a new lesson before an existing quiz/assignment. The section
        // lock serializes this with concurrent appends and reorders.
        await lockSectionRow(tx, sectionId);
        const order = await nextUnitOrder(tx, sectionId);
        const created = await this.lessonsRepository.create(tx, {
          section: { connect: { id: sectionId } },
          courseId,
          title: payload.title,
          description: payload.description,
          contentType: payload.contentType,
          contentUrl: payload.contentUrl,
          status: payload.status,
          order,
          // These four were declared by `CreateCourseLessonDto` and
          // persisted by nothing, so a lesson created as a free preview,
          // with a video, a drip date or a watched-ratio rule came back
          // 201 and silently had none of them — the author had to save a
          // second time through `updateLesson` for any of it to stick.
          // `null` clears, `undefined` leaves the column at its default,
          // matching the update path's distinction exactly.
          ...(payload.videoAssetId
            ? { videoAsset: { connect: { id: payload.videoAssetId } } }
            : {}),
          ...(payload.isPreview !== undefined ? { isPreview: payload.isPreview } : {}),
          ...(payload.availableAt !== undefined
            ? { availableAt: payload.availableAt ? new Date(payload.availableAt) : null }
            : {}),
          ...(payload.completionRule !== undefined
            ? { completionRule: payload.completionRule }
            : {}),
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course_lesson.created',
          targetType: 'course_lesson',
          targetId: created.id,
          targetLabel: created.title,
          // Named for the same reason the update path names them: the
          // video link and the preview flag are what a reviewer looks for.
          context: {
            courseId,
            sectionId,
            ...(payload.videoAssetId !== undefined
              ? { videoAssetId: payload.videoAssetId }
              : {}),
            ...(payload.isPreview !== undefined ? { isPreview: payload.isPreview } : {}),
          },
        });

        return created;
      },
    );

    return toCourseLessonResponse(lesson);
  }

  async updateLesson(
    lessonId: string,
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UpdateCourseLessonDto,
  ): Promise<CourseLessonResponse> {
    const lesson = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId, courseId);
        await this.assertCourseInAcademy(tx, courseId, academyId);
        await this.assertSectionInCourse(tx, sectionId, courseId);
        await this.assertLessonInSection(tx, lessonId, sectionId);

        // P64 Phase 2 — attaching a video is a TENANCY decision, so the
        // asset is verified against THIS academy before it is linked. An
        // id alone proves nothing: without this check an author could
        // attach another academy's video by guessing, and the grant path
        // would then happily sign it because the lesson says it is theirs.
        if (payload.videoAssetId) {
          await assertAttachableLessonVideo(
            tx,
            academyId,
            courseId,
            payload.videoAssetId,
          );
        }

        const updated = await this.lessonsRepository.update(tx, lessonId, {
          title: payload.title,
          description: payload.description,
          contentType: payload.contentType,
          contentUrl: payload.contentUrl,
          status: payload.status,
          // `undefined` leaves a field alone; `null` deliberately clears
          // it. That distinction matters here — detaching a video and
          // "not mentioning the video" are different requests.
          ...(payload.videoAssetId !== undefined
            ? {
                videoAsset: payload.videoAssetId
                  ? { connect: { id: payload.videoAssetId } }
                  : { disconnect: true },
              }
            : {}),
          ...(payload.isPreview !== undefined ? { isPreview: payload.isPreview } : {}),
          ...(payload.availableAt !== undefined
            ? { availableAt: payload.availableAt ? new Date(payload.availableAt) : null }
            : {}),
          ...(payload.completionRule !== undefined
            ? { completionRule: payload.completionRule }
            : {}),
        });

        // B0-LRN-01 — at read time a content row WINS over the legacy
        // fields this endpoint edits (`effectiveLessonContent`), so a row
        // that no longer describes the lesson must go, or learners keep
        // getting the old body:
        //   - a `text` row when the lesson is no longer a text lesson;
        //   - an `external` row (the Phase 2 backfill's shape for a legacy
        //     URL) when the author changed that URL here;
        //   - a `file` row when the lesson is no longer a file lesson
        //     (B0-MED-05: switching a File lesson to Text or Video kept
        //     serving the file, since the row wins).
        // A `video` row points at a protected video written through the
        // content endpoint and is left alone.
        const content = await this.lessonContentsRepository.findByLessonId(tx, lessonId);
        if (
          content &&
          ((content.kind === 'text' && updated.contentType !== 'text') ||
            (content.kind === 'file' && updated.contentType !== 'file') ||
            (content.kind === 'external' &&
              payload.contentUrl !== undefined &&
              content.externalUrl !== (updated.contentUrl ?? null)))
        ) {
          await this.lessonContentsRepository.deleteForLesson(tx, lessonId);
        }

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course_lesson.updated',
          targetType: 'course_lesson',
          targetId: lessonId,
          targetLabel: updated.title,
          // The video link and the preview flag are the two changes a
          // reviewer is most likely to be looking for later, so they are
          // named rather than buried in a diff.
          context: {
            courseId,
            sectionId,
            ...(payload.videoAssetId !== undefined
              ? { videoAssetId: payload.videoAssetId }
              : {}),
            ...(payload.isPreview !== undefined ? { isPreview: payload.isPreview } : {}),
          },
        });

        return updated;
      },
    );

    return toCourseLessonResponse(lesson);
  }

  /**
   * B0-LRN-01 — the staff read of a lesson's content row, so the builder
   * can show an existing text body for editing.
   *
   * Same ladder as the write below (manage permission, then course,
   * section, lesson): anyone who can read the body here can already
   * replace it through `upsertLessonContent`, so this read is never wider
   * than the write. Learners never reach it; they read bodies only
   * through the grant path.
   */
  async getLessonContent(
    lessonId: string,
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<LessonContentResponse> {
    const content = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId, courseId);
        await this.assertCourseInAcademy(tx, courseId, academyId);
        await this.assertSectionInCourse(tx, sectionId, courseId);
        await this.assertLessonInSection(tx, lessonId, sectionId);
        return this.lessonContentsRepository.findByLessonId(tx, lessonId);
      },
    );
    if (!content) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toLessonContentResponse(content, { includeBody: true });
  }

  /**
   * Creates or replaces the lesson's protected content row.
   *
   * This is the writer `lesson_contents` never had. The table, its RLS
   * policies and a one-time backfill shipped with Phase 2's first
   * migration, but nothing could author a row afterwards — so every
   * lesson created since had no content, and `LessonContentService`
   * refused its grant. That refusal is correct and is left untouched;
   * what was missing is the row it looks for.
   *
   * ORDER OF CHECKS IS THE POINT. Manage-permission, then course, then
   * section, then lesson — the same ladder every other write on this
   * service climbs — before a single field of the payload is trusted. A
   * caller who cannot manage this academy learns nothing about whether
   * the ids they guessed exist.
   */
  async upsertLessonContent(
    lessonId: string,
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UpsertLessonContentDto,
  ): Promise<LessonContentResponse> {
    // B0-LRN-01 — a text body is sanitised BEFORE the transaction opens:
    // the stored HTML is the sanitiser's rebuilt output, never the input,
    // and a body that sanitises to nothing readable is refused rather than
    // stored as a lesson that delivers an empty page.
    let bodyHtml: string | null = null;
    if (payload.kind === 'text') {
      const sanitized = sanitizeRichText(payload.bodyHtml ?? '');
      if (sanitized.text.trim().length === 0) {
        throw new BadRequestException({
          messageKey: 'errors.lessonContent.bodyRequired',
        });
      }
      bodyHtml = sanitized.html;
    } else if (payload.bodyHtml !== undefined) {
      throw new BadRequestException({
        messageKey: 'errors.lessonContent.unexpectedBody',
      });
    }

    const content = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId, courseId);
        await this.assertCourseInAcademy(tx, courseId, academyId);
        await this.assertSectionInCourse(tx, sectionId, courseId);
        await this.assertLessonInSection(tx, lessonId, sectionId);

        let mediaAssetId: string | null = null;
        let externalUrl: string | null = null;

        if (payload.kind === 'video' || payload.kind === 'file') {
          if (!payload.mediaAssetId) {
            throw new BadRequestException({
              messageKey: 'errors.lessonContent.mediaAssetRequired',
            });
          }
          // Scoped to THIS academy, exactly as `updateLesson` scopes
          // `videoAssetId`: an id proves nothing on its own, and without
          // this an author could attach another academy's object by
          // guessing, after which the grant path would sign it because
          // the lesson claims it. A miss is `notFound`, not a distinct
          // "wrong academy" — the two must be indistinguishable.
          const asset = await tx.mediaAsset.findFirst({
            where: { id: payload.mediaAssetId, academyId },
            select: { id: true, type: true, access: true, courseId: true },
          });
          if (!asset) throw new NotFoundException({ messageKey: 'errors.notFound' });
          // B0-MED-05 — a protected file uploaded for one course cannot be
          // attached to another course's lesson (its object sits under that
          // course's key prefix). Indistinguishable from a miss, like the
          // academy check above.
          if (asset.courseId !== null && asset.courseId !== courseId) {
            throw new NotFoundException({ messageKey: 'errors.notFound' });
          }

          if (payload.kind === 'video' && asset.type !== 'video') {
            throw new BadRequestException({
              messageKey: 'errors.lessonContent.assetNotVideo',
            });
          }
          // A `file` lesson body must live in the protected bucket. A
          // public object would be readable by URL by anyone it was
          // forwarded to, which is the durable-link problem this whole
          // phase exists to remove — accepting one here would reintroduce
          // it behind a field named "protected content".
          // B0-MED-11 — the same holds for a hosted video: a public one
          // would skip the signed grant, the device rules and the watermark.
          if (
            (payload.kind === 'file' || payload.kind === 'video') &&
            asset.access !== 'protected'
          ) {
            throw new BadRequestException({
              messageKey: 'errors.lessonContent.assetNotProtected',
            });
          }
          mediaAssetId = asset.id;
        }

        if (payload.kind === 'external') {
          if (!payload.externalUrl) {
            throw new BadRequestException({
              messageKey: 'errors.lessonContent.externalUrlRequired',
            });
          }
          if (payload.mediaAssetId) {
            throw new BadRequestException({
              messageKey: 'errors.lessonContent.unexpectedMediaAsset',
            });
          }
          externalUrl = payload.externalUrl;
        }

        // `courseId`/`academyId` are denormalised onto the row so every
        // RLS policy decides tenancy without a join. They are taken from
        // the VERIFIED context above, never from the payload.
        const saved = await this.lessonContentsRepository.upsertForLesson(tx, lessonId, {
          courseId,
          academyId,
          kind: payload.kind,
          bodyHtml,
          mediaAssetId,
          externalUrl,
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course_lesson.content_updated',
          targetType: 'course_lesson',
          targetId: lessonId,
          context: {
            courseId,
            sectionId,
            kind: payload.kind,
            ...(mediaAssetId ? { mediaAssetId } : {}),
          },
        });

        return saved;
      },
    );

    return toLessonContentResponse(content);
  }

  async deleteLesson(
    lessonId: string,
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const role = await this.assertCanManage(tx, academyId, userId, courseId);
      await this.assertCourseInAcademy(tx, courseId, academyId);
      await this.assertSectionInCourse(tx, sectionId, courseId);
      const lesson = await this.assertLessonInSection(tx, lessonId, sectionId);
      // Refused once any learner has progress in it — the FK cascade would
      // erase that record (see `learner-activity.guard.ts`).
      await assertNoLearnerActivity(tx, { kind: 'lesson', id: lessonId });
      await this.lessonsRepository.delete(tx, lessonId);

      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'course_lesson.deleted',
        targetType: 'course_lesson',
        targetId: lessonId,
        targetLabel: lesson.title,
        context: { courseId, sectionId },
      });
    });
  }

  async reorderLessons(
    sectionId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
    userId: string,
    payload: ReorderItemsDto,
  ): Promise<void> {
    // LEGACY ENDPOINT, SAME CONTRACT. It still takes the full ordering of the
    // unit's LESSONS only, but it no longer renumbers lessons 0..n-1 in
    // isolation (which collided with quiz/assignment ordinals in the shared
    // unit space). Instead the requested lesson order is laid into the
    // positions lessons already occupy in the unified sequence, so every
    // non-lesson item keeps its place, and the whole unit is renumbered
    // contiguously. Combined context because quiz/assignment rows may be
    // renumbered too (their write policies are per-user).
    await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId, courseId);
        await this.assertCourseInAcademy(tx, courseId, academyId);
        const section = await this.assertSectionInCourse(tx, sectionId, courseId);
        await lockSectionRow(tx, sectionId);

        const items = await readUnitItems(tx, sectionId);
        const lessons = items.filter((i) => i.type === 'lesson');
        const currentLessonIds = lessons.map((l) => l.id);
        assertExpectedOrder(currentLessonIds, payload.expectedOrderedIds);
        this.assertExactPermutation(currentLessonIds, payload.orderedIds);

        const lessonById = new Map(lessons.map((l) => [l.id, l]));
        const queue = payload.orderedIds.map((id) => lessonById.get(id)!);
        const merged = items.map((item) =>
          item.type === 'lesson' ? queue.shift()! : item,
        );
        await persistUnitOrder(tx, merged);

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'course.curriculum.items_reordered',
          targetType: 'course_section',
          targetId: sectionId,
          targetLabel: section.title,
          context: {
            courseId,
            sectionId,
            itemCount: merged.length,
            legacyLessonsEndpoint: true,
          },
          changes: {
            order: { from: items.map((i) => i.id), to: merged.map((i) => i.id) },
          },
        });
      },
    );
  }

  /** Returns the caller's real Academy-membership role (Phase 8) — used as the `role` attributed on each mutation's audit-log entry. */
  private async assertCanManage(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
    courseId?: string,
  ): Promise<string> {
    const managingRole = await this.academyMembersRepository.findManagingRole(
      tx,
      academyId,
      userId,
      MANAGING_ROLES,
    );
    if (managingRole) return managingRole;
    // P64 Phase 1 (RBAC matrix: "Edit curriculum — Instructor: yes, assigned
    // courses") — the course's own assigned instructor may edit its
    // curriculum; `can_author_course_content()` is the RLS twin.
    if (courseId) {
      const isInstructor = await this.courseInstructorsRepository.isInstructor(
        tx,
        courseId,
        userId,
      );
      if (isInstructor) return 'instructor';
    }
    throw new ForbiddenException({ messageKey: 'errors.course.insufficientRole' });
  }

  private async assertCourseInAcademy(
    tx: Prisma.TransactionClient,
    courseId: string,
    academyId: string,
  ): Promise<void> {
    const course = await this.coursesRepository.findById(tx, courseId);
    if (!course || course.academyId !== academyId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
  }

  /** Returns the section row (Phase 8's `deleteSection` needs its `title` for the audit-log `targetLabel` after the row itself is gone). */
  private async assertSectionInCourse(
    tx: Prisma.TransactionClient,
    sectionId: string,
    courseId: string,
  ): Promise<{ id: string; title: string; courseId: string }> {
    const section = await this.sectionsRepository.findById(tx, sectionId);
    if (!section || section.courseId !== courseId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return section;
  }

  /** Returns the lesson row — see `assertSectionInCourse`'s identical reasoning. */
  private async assertLessonInSection(
    tx: Prisma.TransactionClient,
    lessonId: string,
    sectionId: string,
  ): Promise<{ id: string; title: string; sectionId: string }> {
    const lesson = await this.lessonsRepository.findById(tx, lessonId);
    if (!lesson || lesson.sectionId !== sectionId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return lesson;
  }

  /** `orderedIds` must be exactly the current set of child ids, no more, no fewer — never a partial reorder, never smuggling in a foreign id. */
  private assertExactPermutation(
    existingIds: readonly string[],
    orderedIds: readonly string[],
  ): void {
    if (!isExactPermutation(existingIds, orderedIds)) {
      throw new BadRequestException({ messageKey: 'errors.course.invalidReorderSet' });
    }
  }
}

/**
 * B0-MED-11 — what a lesson may point at as its hosted video.
 *
 *   - this academy's own video asset (tenancy — an id alone proves nothing);
 *   - a PROTECTED one: a public library video is served from a public URL,
 *     so attaching it would bypass the signed grant, the device rules and
 *     the watermark the learner path enforces for `videoAssetId`;
 *   - whose upload has finished: `pending` means the bytes never arrived
 *     (the completion call was not made), `failed` means they never will.
 *     `processing` is accepted — the learner path already answers
 *     "processing" until the asset is ready;
 *   - still in the library: an archived (deleted, awaiting purge) or purged
 *     asset is gone as far as the product is concerned;
 *   - uploaded for THIS course or for none — the B0-MED-05 rule the lesson
 *     content path (`upsertLessonContent`) already applies to the same
 *     asset, so the two ways of pointing a lesson at a video agree.
 * The last two are indistinguishable from a miss, like the academy check.
 */
export async function assertAttachableLessonVideo(
  tx: Prisma.TransactionClient,
  academyId: string,
  courseId: string,
  videoAssetId: string,
): Promise<void> {
  const asset = await tx.mediaAsset.findFirst({
    where: { id: videoAssetId, academyId, type: 'video', status: 'active' },
    select: { id: true, access: true, processingStatus: true, courseId: true },
  });
  if (!asset || (asset.courseId !== null && asset.courseId !== courseId)) {
    throw new NotFoundException({ messageKey: 'errors.notFound' });
  }
  if (asset.access !== 'protected') {
    throw new BadRequestException({ messageKey: 'errors.media.videoNotAttachable' });
  }
  if (asset.processingStatus === 'pending' || asset.processingStatus === 'failed') {
    throw new ConflictException({ messageKey: 'errors.media.videoNotReady' });
  }
}
