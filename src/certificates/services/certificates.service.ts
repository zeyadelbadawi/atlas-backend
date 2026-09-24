/**
 * P64 Phase 3 (D6, D7, AD-11) — the certificate lifecycle.
 *
 *   eligibility → issuance (automatic on the queue, or manual by owner /
 *   manager) → render (queue) → download (1-hour signed link) → public
 *   verification → revocation → explicit regeneration.
 *
 * Context discipline: issuance, revocation, regeneration and rendering
 * run in the academy's TENANT context (a learner must never be the
 * principal that writes their own certificate state); the learner's own
 * reads run in their user context (self policy); verification goes
 * through the SECURITY DEFINER projection that exposes public fields only.
 *
 * Immutability (D7): `snapshot` is written once at issuance. A later
 * retake, rename or template edit never touches it. Regeneration is an
 * explicit reviewer action that builds a NEW snapshot for a new version
 * while keeping the serial and the verification code — and it carries
 * the ORIGINAL score summary forward, so even regeneration never rewrites
 * what was scored at issuance.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Certificate, Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import type { EmitResult } from '../../communications/services/communication.service';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import { ProtectedMediaStorage } from '../../media/storage/protected-media-storage.provider';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type {
  CertificatesConfig,
  PlatformDomainRuntimeConfig,
} from '../../config/configuration';
import {
  CertificatesRepository,
  type CertificateWithNames,
} from '../certificates.repository';
import { CertificateRendererService } from './certificate-renderer.service';
import {
  academySerialPrefix,
  formatSerial,
  formatVerificationCode,
  generateVerificationCode,
  isPlausibleVerificationCode,
  normalizeVerificationCode,
} from '../certificate-serial.util';
import {
  parseWording,
  toCertificateResponse,
  toTemplateResponse,
  type CertificateDownloadResponse,
  type CertificateResponse,
  type CertificateSnapshot,
  type CertificateTemplateResponse,
  type CertificateVerificationResponse,
} from '../dto/certificate.contract';
import { assertReadablePalette, paletteFromTemplate } from '../certificate-palette.util';
import type {
  IssueCertificateDto,
  ListCertificatesQueryDto,
  RegenerateCertificateDto,
  RevokeCertificateDto,
  UpdateCertificateTemplateDto,
} from '../dto/certificate.dto';
import {
  CERTIFICATE_JOBS_QUEUE,
  CERTIFICATE_RENDER_JOB,
  type CertificateRenderJobPayload,
} from '../queue/certificate-jobs.types';

const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);
const VERIFY_MIN_DURATION_MS = 150;
const DEFAULT_TEMPLATE_NAME = 'Standard';

/** Placeholder people/courses for the editor's live preview (never persisted). */
const SAMPLE_PREVIEW_DATA = {
  en: {
    learnerName: 'Alexandra Whitmore',
    courseTitle: 'Advanced Data Analysis & Visualization',
    academyName: 'Your Academy',
    instructor: 'Dr. Jordan Hayes',
  },
  ar: {
    learnerName: 'فاطمة عبد الرحمن الزهراني',
    courseTitle: 'تحليل البيانات المتقدم والتصور المرئي',
    academyName: 'أكاديميتك',
    instructor: 'د. خالد المنصوري',
  },
} as const;

type StaffScope =
  | { readonly kind: 'academy'; readonly role: string }
  | { readonly kind: 'courses'; readonly courseIds: readonly string[] };

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);
  private readonly config: CertificatesConfig;
  private readonly platformDomain: PlatformDomainRuntimeConfig | undefined;

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academiesRepository: AcademiesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly communications: CommunicationService,
    private readonly metrics: LearningMetricsService,
    private readonly storage: ProtectedMediaStorage,
    private readonly repository: CertificatesRepository,
    private readonly renderer: CertificateRendererService,
    configService: ConfigService,
    @InjectQueue(CERTIFICATE_JOBS_QUEUE) private readonly queue: Queue,
  ) {
    this.config = configService.getOrThrow<CertificatesConfig>('certificates');
    this.platformDomain =
      configService.get<PlatformDomainRuntimeConfig>('platformDomain');
  }

  // ---------------------------------------------------------------------
  // issuance
  // ---------------------------------------------------------------------

  /** Queue path: re-checks eligibility under the academy's tenant context; idempotent. */
  async issueAutomatically(
    enrollmentId: string,
    academyId: string,
  ): Promise<'issued' | 'skipped'> {
    const organizationId =
      await this.academiesRepository.resolveOrganizationId(academyId);
    if (!organizationId) return 'skipped';
    let issued: Certificate | null;
    try {
      issued = await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
        this.issueInTransaction(tx, {
          enrollmentId,
          academyId,
          organizationId,
          actorUserId: null,
          force: false,
          reason: null,
        }),
      );
    } catch (error) {
      // Another issuer (a manual issue, or a second job) won the race on the
      // per-enrollment uniqueness: the certificate exists, nothing to do.
      if ((error as { code?: string }).code === 'P2002') return 'skipped';
      throw error;
    }
    if (!issued) return 'skipped';
    await this.afterIssue(issued, organizationId);
    this.metrics.recordCertificateIssued('automatic');
    return 'issued';
  }

  /** Staff path (owner / manager): manual issuance for edge cases, audited. */
  async issueManually(
    academyId: string,
    organizationId: string,
    actorUserId: string,
    enrollmentId: string,
    dto: IssueCertificateDto,
  ): Promise<CertificateResponse> {
    const result = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.assertManagingRole(tx, academyId, actorUserId);
        const certificate = await this.issueInTransaction(tx, {
          enrollmentId,
          academyId,
          organizationId,
          actorUserId,
          force: dto.force === true,
          reason: dto.reason ?? null,
        });
        if (!certificate) {
          const existing = await this.repository.findByEnrollment(tx, enrollmentId);
          if (existing) return { certificate: existing, created: false };
          throw new ConflictException({ messageKey: 'errors.certificate.notEligible' });
        }
        return { certificate, created: true };
      },
    );
    if (result.created) {
      await this.afterIssue(result.certificate, organizationId);
      this.metrics.recordCertificateIssued('manual');
    }
    return this.getForAcademy(
      academyId,
      organizationId,
      actorUserId,
      result.certificate.id,
    );
  }

  private async issueInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly enrollmentId: string;
      readonly academyId: string;
      readonly organizationId: string;
      readonly actorUserId: string | null;
      readonly force: boolean;
      readonly reason: string | null;
    },
  ): Promise<Certificate | null> {
    // Serialise concurrent issuers (the queue job and a manual issue can
    // race): lock the enrollment row first, so the second transaction sees
    // the certificate the first one inserted.
    await tx.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "enrollments" WHERE "id" = ${input.enrollmentId} FOR UPDATE`;
    const enrollment = await tx.enrollment.findFirst({
      where: { id: input.enrollmentId, academyId: input.academyId },
      include: {
        student: { select: { id: true, name: true, email: true, preferences: true } },
        course: {
          select: {
            id: true,
            title: true,
            slug: true,
            certificatesEnabled: true,
            certificateMinScore: true,
            certificateTemplateId: true,
            instructors: { select: { user: { select: { name: true } } } },
          },
        },
        progress: true,
      },
    });
    if (!enrollment) throw new NotFoundException({ messageKey: 'errors.notFound' });
    const academy = await tx.academy.findUnique({
      where: { id: input.academyId },
      select: { id: true, name: true, slug: true, language: true, logoUrl: true },
    });
    if (!academy) throw new NotFoundException({ messageKey: 'errors.notFound' });

    const existing = await this.repository.findByEnrollment(tx, input.enrollmentId);
    if (existing && existing.status === 'issued') return null;
    if (existing && existing.status === 'revoked' && !input.force) return null;

    // Readiness follows the academy's ACTUAL configuration — the course's
    // `certificatesEnabled` toggle (which requires a configured template) —
    // not an env rollout allowlist. Configuring certificates is therefore
    // enough to make an academy certificate-ready (P4 Issue F root cause).
    const progress = enrollment.progress;
    const completed = progress?.completionState === 'completed';
    const overallScore =
      progress?.overallScore !== null && progress?.overallScore !== undefined
        ? Number(progress.overallScore)
        : null;
    const minScoreMet =
      enrollment.course.certificateMinScore === null ||
      (overallScore !== null && overallScore >= enrollment.course.certificateMinScore);
    const eligible = enrollment.course.certificatesEnabled && completed && minScoreMet;
    if (!eligible && !input.force) return null;
    // Force-issue (owner override) still requires the course to award a
    // certificate at all; it only bypasses the completion/score gate.
    if (input.force && !enrollment.course.certificatesEnabled) {
      throw new ForbiddenException({ messageKey: 'errors.certificate.featureDisabled' });
    }

    // Template: the course's, else the academy default (created lazily).
    const template =
      (enrollment.course.certificateTemplateId
        ? await this.repository.findTemplateById(
            tx,
            enrollment.course.certificateTemplateId,
          )
        : null) ??
      (await this.ensureDefaultTemplate(
        tx,
        input.academyId,
        academy.name,
        academy.logoUrl,
      ));

    // Score summary at issuance (D7: frozen).
    const [results, quizzes, submissions, assignments] = await Promise.all([
      tx.quizResult.findMany({
        where: {
          studentId: enrollment.studentId,
          quiz: { courseId: enrollment.courseId, requiredForCompletion: true },
        },
      }),
      tx.quiz.findMany({
        where: { courseId: enrollment.courseId, requiredForCompletion: true },
        select: { id: true, title: true },
      }),
      tx.assignmentSubmission.findMany({
        where: {
          studentId: enrollment.studentId,
          gradingStatus: 'graded',
          assignment: { courseId: enrollment.courseId, requiredForCompletion: true },
        },
        select: { assignmentId: true, score: true },
      }),
      tx.assignment.findMany({
        where: { courseId: enrollment.courseId, requiredForCompletion: true },
        select: { id: true, title: true },
      }),
    ]);
    const scoreByQuiz = new Map(
      results.map((r) => [
        r.quizId,
        r.effectiveScore !== null ? Number(r.effectiveScore) : null,
      ]),
    );
    const scoreByAssignment = new Map(
      submissions.map((s) => [s.assignmentId, s.score !== null ? Number(s.score) : null]),
    );
    const scoreSummary = [
      ...quizzes.map((q) => ({ title: q.title, score: scoreByQuiz.get(q.id) ?? null })),
      ...assignments.map((a) => ({
        title: a.title,
        score: scoreByAssignment.get(a.id) ?? null,
      })),
    ];

    const locale = this.localeFor(enrollment.student.preferences, academy.language);
    const now = new Date();
    const snapshot: CertificateSnapshot = {
      learnerName: enrollment.student.name,
      learnerEmailMasked: maskEmail(enrollment.student.email),
      courseTitle: enrollment.course.title,
      courseSlug: enrollment.course.slug,
      academyName: academy.name,
      academySlug: academy.slug,
      instructors: enrollment.course.instructors.map(
        (row: { user: { name: string } }) => row.user.name,
      ),
      completedAt: (progress?.completedAt ?? enrollment.completedAt ?? now).toISOString(),
      overallScore,
      scoreSummary,
      templateVersion: template.version,
      templateId: template.id,
      logoUrl: template.logoUrl,
      signatureUrl: template.signatureUrl,
      signatoryName: template.signatoryName,
      signatoryTitle: template.signatoryTitle,
      wording: parseWording(template.wording),
      palette: paletteFromTemplate(template),
      locale,
    };

    let certificate: Certificate;
    if (existing) {
      // Re-issue after revocation (explicit, forced): same serial and code, new version.
      certificate = await this.repository.update(tx, existing.id, {
        status: 'issued',
        revokedAt: null,
        revokedBy: { disconnect: true },
        revokeReason: null,
        version: existing.version + 1,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        templateId: template.id,
        templateVersion: template.version,
        locale,
        issuedAt: now,
        issuedBy: input.actorUserId
          ? { connect: { id: input.actorUserId } }
          : { disconnect: true },
        renderStatus: 'pending',
        storageKey: null,
        renderedAt: null,
        renderError: null,
      });
    } else {
      const year = now.getUTCFullYear();
      const serialValue = await this.repository.nextSerialValue(
        tx,
        input.academyId,
        year,
      );
      const serial = formatSerial(
        academySerialPrefix(academy.name, academy.slug),
        year,
        serialValue,
      );
      certificate = await this.createWithFreshCode(tx, {
        academyId: input.academyId,
        courseId: enrollment.courseId,
        enrollmentId: enrollment.id,
        studentId: enrollment.studentId,
        serial,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        templateId: template.id,
        templateVersion: template.version,
        locale,
        issuedAt: now,
        issuedById: input.actorUserId,
      });
    }

    await tx.courseProgress.updateMany({
      where: { enrollmentId: enrollment.id },
      data: { certificateStatus: 'issued' },
    });

    await this.auditLogWriterService.write(tx, {
      actorUserId: input.actorUserId ?? enrollment.studentId,
      organizationId: input.organizationId,
      academyId: input.academyId,
      role: input.actorUserId
        ? await this.roleOf(tx, input.academyId, input.actorUserId)
        : 'system',
      action: existing ? 'certificate.reissued' : 'certificate.issued',
      targetType: 'certificate',
      targetId: certificate.id,
      targetLabel: certificate.serial,
      context: {
        enrollmentId: enrollment.id,
        courseId: enrollment.courseId,
        studentId: enrollment.studentId,
        automatic: input.actorUserId === null,
        forced: input.force,
        reason: input.reason,
        overallScore,
      },
    });
    return certificate;
  }

  /**
   * A collision on a 60-bit code is not expected in the lifetime of the
   * platform, but the check is cheap and — unlike catching a unique
   * violation — does not abort the surrounding PostgreSQL transaction.
   */
  private async createWithFreshCode(
    tx: Prisma.TransactionClient,
    data: Omit<Prisma.CertificateUncheckedCreateInput, 'verificationCode'>,
  ): Promise<Certificate> {
    let verificationCode = generateVerificationCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const clash = await tx.$queryRaw<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM "certificates" WHERE "verification_code" = ${verificationCode}`;
      if (Number(clash[0]?.n ?? 0) === 0) break;
      verificationCode = generateVerificationCode();
    }
    return this.repository.create(tx, { ...data, verificationCode });
  }

  private async afterIssue(
    certificate: Certificate,
    organizationId: string,
  ): Promise<void> {
    await this.enqueueRender(certificate.id, certificate.academyId);
    const snapshot = certificate.snapshot as unknown as CertificateSnapshot;
    const emitted: EmitResult = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.communications.emit(tx, {
          key: 'certificate.issued',
          recipientUserId: certificate.studentId,
          organizationId,
          academyId: certificate.academyId,
          entity: { type: 'certificate', id: certificate.id },
          values: {
            courseTitle: snapshot.courseTitle,
            academyName: snapshot.academyName,
            verificationCode: formatVerificationCode(certificate.verificationCode),
            version: certificate.version,
          },
        }),
    );
    await this.communications.enqueueAfterCommit(emitted.outboxId);
  }

  // ---------------------------------------------------------------------
  // revoke / regenerate (owner / manager)
  // ---------------------------------------------------------------------

  async revoke(
    academyId: string,
    organizationId: string,
    actorUserId: string,
    certificateId: string,
    dto: RevokeCertificateDto,
  ): Promise<CertificateResponse> {
    const revoked = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const role = await this.assertManagingRole(tx, academyId, actorUserId);
        const certificate = await this.repository.findById(tx, certificateId);
        if (!certificate || certificate.academyId !== academyId)
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        if (certificate.status === 'revoked') return certificate;
        const now = new Date();
        await this.repository.update(tx, certificateId, {
          status: 'revoked',
          revokedAt: now,
          revokedBy: { connect: { id: actorUserId } },
          revokeReason: dto.reason,
        });
        await tx.courseProgress.updateMany({
          where: { enrollmentId: certificate.enrollmentId },
          data: { certificateStatus: 'revoked' },
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId,
          organizationId,
          academyId,
          role,
          action: 'certificate.revoked',
          targetType: 'certificate',
          targetId: certificateId,
          targetLabel: certificate.serial,
          context: {
            reason: dto.reason,
            studentId: certificate.studentId,
            courseId: certificate.courseId,
          },
        });
        const snapshot = certificate.snapshot as unknown as CertificateSnapshot;
        const emitted = await this.communications.emit(tx, {
          key: 'certificate.revoked',
          recipientUserId: certificate.studentId,
          organizationId,
          academyId: certificate.academyId,
          entity: { type: 'certificate', id: certificateId },
          values: {
            courseTitle: snapshot.courseTitle,
            academyName: snapshot.academyName,
            revokedAtMs: now.getTime(),
          },
        });
        return { ...certificate, emitted };
      },
    );
    if ('emitted' in revoked) {
      await this.communications.enqueueAfterCommit(revoked.emitted.outboxId);
    }
    return this.getForAcademy(academyId, organizationId, actorUserId, certificateId);
  }

  /**
   * Explicit regeneration (D6/D7): a new version from a new snapshot (the
   * learner's current name, the current template) that KEEPS the serial,
   * the verification code, the completion date and the score summary as
   * they were at issuance. Never a side effect of anything.
   */
  async regenerate(
    academyId: string,
    organizationId: string,
    actorUserId: string,
    certificateId: string,
    dto: RegenerateCertificateDto,
  ): Promise<CertificateResponse> {
    const updated = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const role = await this.assertManagingRole(tx, academyId, actorUserId);
        const certificate = await this.repository.findById(tx, certificateId);
        if (!certificate || certificate.academyId !== academyId)
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        if (certificate.status !== 'issued') {
          throw new ConflictException({ messageKey: 'errors.certificate.notIssued' });
        }
        const original = certificate.snapshot as unknown as CertificateSnapshot;
        const template =
          (certificate.templateId
            ? await this.repository.findTemplateById(tx, certificate.templateId)
            : null) ??
          (await this.ensureDefaultTemplate(
            tx,
            academyId,
            original.academyName,
            original.logoUrl,
          ));
        const academy = await tx.academy.findUnique({
          where: { id: academyId },
          select: { name: true, slug: true },
        });
        const snapshot: CertificateSnapshot = {
          ...original,
          learnerName: original.anonymizedAt
            ? original.learnerName
            : certificate.student.name,
          courseTitle: certificate.course.title,
          courseSlug: certificate.course.slug,
          academyName: academy?.name ?? original.academyName,
          academySlug: academy?.slug ?? original.academySlug,
          templateVersion: template.version,
          templateId: template.id,
          logoUrl: template.logoUrl,
          signatureUrl: template.signatureUrl,
          signatoryName: template.signatoryName,
          signatoryTitle: template.signatoryTitle,
          wording: parseWording(template.wording),
          palette: paletteFromTemplate(template),
          // Frozen at issuance, deliberately carried forward:
          completedAt: original.completedAt,
          overallScore: original.overallScore,
          scoreSummary: original.scoreSummary,
        };
        const row = await this.repository.update(tx, certificateId, {
          version: certificate.version + 1,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          templateId: template.id,
          templateVersion: template.version,
          renderStatus: 'pending',
          storageKey: null,
          renderedAt: null,
          renderError: null,
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId,
          organizationId,
          academyId,
          role,
          action: 'certificate.regenerated',
          targetType: 'certificate',
          targetId: certificateId,
          targetLabel: certificate.serial,
          context: {
            version: row.version,
            reason: dto.reason ?? null,
            templateVersion: template.version,
          },
        });
        return row;
      },
    );
    await this.enqueueRender(updated.id, academyId);
    this.metrics.recordCertificateIssued('regenerated');
    return this.getForAcademy(academyId, organizationId, actorUserId, certificateId);
  }

  // ---------------------------------------------------------------------
  // staff reads
  // ---------------------------------------------------------------------

  async listForAcademy(
    academyId: string,
    organizationId: string,
    userId: string,
    query: ListCertificatesQueryDto,
  ): Promise<PaginatedResult<CertificateResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const scope = await this.resolveStaffScope(tx, academyId, userId);
      if (
        scope.kind === 'courses' &&
        query.courseId &&
        !scope.courseIds.includes(query.courseId)
      ) {
        return { items: [], pagination: buildPaginationMeta(page, pageSize, 0) };
      }
      const courseFilter =
        scope.kind === 'courses' && !query.courseId
          ? scope.courseIds
          : query.courseId
            ? [query.courseId]
            : null;
      if (courseFilter && courseFilter.length === 0) {
        return { items: [], pagination: buildPaginationMeta(page, pageSize, 0) };
      }
      const { items, totalItems } = await this.repository.findManyForAcademy(
        tx,
        academyId,
        {
          courseId:
            courseFilter && courseFilter.length === 1 ? courseFilter[0] : undefined,
          status: query.status,
          search: query.search,
          skip: (page - 1) * pageSize,
          take: pageSize,
        },
      );
      const visible =
        courseFilter && courseFilter.length > 1
          ? items.filter((c) => courseFilter.includes(c.courseId))
          : items;
      return {
        items: visible.map((row) => toCertificateResponse(row, { includeEmail: true })),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  async getForAcademy(
    academyId: string,
    organizationId: string,
    userId: string,
    certificateId: string,
  ): Promise<
    CertificateResponse & { readonly download: CertificateDownloadResponse | null }
  > {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const scope = await this.resolveStaffScope(tx, academyId, userId);
      const certificate = await this.repository.findById(tx, certificateId);
      if (!certificate || certificate.academyId !== academyId)
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      if (scope.kind === 'courses' && !scope.courseIds.includes(certificate.courseId)) {
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      }
      return {
        ...toCertificateResponse(certificate, { includeEmail: true }),
        download: await this.downloadLink(certificate),
      };
    });
  }

  // ---------------------------------------------------------------------
  // learner reads
  // ---------------------------------------------------------------------

  async listForLearner(
    userId: string,
    academyId: string,
  ): Promise<{ enabled: boolean; items: CertificateResponse[] }> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const items = await this.repository.findManyForStudent(tx, userId, academyId);
      // Certificates follow course configuration now, not a rollout allowlist
      // (P4 Issue F). The academy "issues certificates" if any of its courses
      // awards one; otherwise the learner simply has an empty list.
      const enabled =
        items.length > 0 ||
        (await tx.course.count({
          where: { academyId, certificatesEnabled: true },
        })) > 0;
      return { enabled, items: items.map((row) => toCertificateResponse(row)) };
    });
  }

  async getForLearner(
    userId: string,
    certificateId: string,
  ): Promise<
    CertificateResponse & { readonly download: CertificateDownloadResponse | null }
  > {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const certificate = await this.repository.findById(tx, certificateId);
      if (!certificate || certificate.studentId !== userId)
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      return {
        ...toCertificateResponse(certificate),
        download: await this.downloadLink(certificate),
      };
    });
  }

  async downloadForLearner(
    userId: string,
    certificateId: string,
  ): Promise<CertificateDownloadResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const certificate = await this.repository.findById(tx, certificateId);
      if (!certificate || certificate.studentId !== userId)
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      if (certificate.status !== 'issued')
        throw new ForbiddenException({ messageKey: 'errors.certificate.revoked' });
      const link = await this.downloadLink(certificate);
      if (!link)
        throw new ConflictException({ messageKey: 'errors.certificate.notReady' });
      return link;
    });
  }

  private async downloadLink(
    certificate: Certificate,
  ): Promise<CertificateDownloadResponse | null> {
    if (certificate.renderStatus !== 'ready' || !certificate.storageKey) return null;
    const ttl = this.config.linkTtlSeconds;
    const url = await this.storage.presignGetWithTtl(certificate.storageKey, ttl);
    return {
      certificateId: certificate.id,
      url,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      fileName: `certificate-${certificate.serial}.pdf`,
    };
  }

  // ---------------------------------------------------------------------
  // public verification
  // ---------------------------------------------------------------------

  /** Uniform: unknown, malformed, issued and revoked codes all take ≥ the same minimum time. */
  async verify(rawCode: string): Promise<CertificateVerificationResponse> {
    const started = Date.now();
    let response: CertificateVerificationResponse = { valid: false };
    let result: 'issued' | 'revoked' | 'unknown' = 'unknown';
    if (isPlausibleVerificationCode(rawCode)) {
      const row = await this.repository.verify(normalizeVerificationCode(rawCode));
      if (row) {
        result = row.status;
        response = {
          valid: row.status === 'issued',
          status: row.status,
          serial: row.serial,
          issuedTo: row.issued_to ?? undefined,
          courseTitle: row.course_title ?? undefined,
          academyName: row.academy_name ?? undefined,
          academySlug: row.academy_slug,
          issuedAt: row.issued_at.toISOString(),
          completedAt: row.completed_at,
          revokedAt: row.revoked_at?.toISOString() ?? null,
          version: row.version,
        };
      }
    }
    this.metrics.recordCertificateVerification(result);
    const elapsed = Date.now() - started;
    if (elapsed < VERIFY_MIN_DURATION_MS) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, VERIFY_MIN_DURATION_MS - elapsed),
      );
    }
    return response;
  }

  // ---------------------------------------------------------------------
  // templates (owner / manager)
  // ---------------------------------------------------------------------

  async getTemplate(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<CertificateTemplateResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertManagingRole(tx, academyId, userId);
      const academy = await tx.academy.findUnique({
        where: { id: academyId },
        select: { name: true, logoUrl: true },
      });
      const template = await this.ensureDefaultTemplate(
        tx,
        academyId,
        academy?.name ?? '',
        academy?.logoUrl ?? null,
      );
      return toTemplateResponse(template);
    });
  }

  async updateTemplate(
    academyId: string,
    organizationId: string,
    userId: string,
    dto: UpdateCertificateTemplateDto,
  ): Promise<CertificateTemplateResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const role = await this.assertManagingRole(tx, academyId, userId);
      const academy = await tx.academy.findUnique({
        where: { id: academyId },
        select: { name: true, logoUrl: true },
      });
      const template = await this.ensureDefaultTemplate(
        tx,
        academyId,
        academy?.name ?? '',
        academy?.logoUrl ?? null,
      );
      const wording = dto.wording
        ? parseWording({
            en: { ...parseWording(template.wording).en, ...(dto.wording.en ?? {}) },
            ar: { ...parseWording(template.wording).ar, ...(dto.wording.ar ?? {}) },
          })
        : undefined;
      // Merge any provided colour roles over the template's current palette,
      // then enforce readability/contrast across all four together (one
      // authoritative check). A single bad colour is rejected with a clear key
      // rather than silently coerced.
      const paletteTouched =
        dto.primaryColor !== undefined ||
        dto.accentColor !== undefined ||
        dto.textColor !== undefined ||
        dto.backgroundColor !== undefined;
      const current = paletteFromTemplate(template);
      const palette = paletteTouched
        ? assertReadablePalette({
            primary: dto.primaryColor ?? current.primary,
            accent: dto.accentColor ?? current.accent,
            text: dto.textColor ?? current.text,
            background: dto.backgroundColor ?? current.background,
          })
        : undefined;
      const updated = await this.repository.updateTemplate(tx, template.id, {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
        ...(dto.signatureUrl !== undefined ? { signatureUrl: dto.signatureUrl } : {}),
        ...(dto.signatoryName !== undefined ? { signatoryName: dto.signatoryName } : {}),
        ...(dto.signatoryTitle !== undefined
          ? { signatoryTitle: dto.signatoryTitle }
          : {}),
        ...(wording ? { wording: wording as unknown as Prisma.InputJsonValue } : {}),
        ...(palette
          ? {
              primaryColor: palette.primary,
              accentColor: palette.accent,
              textColor: palette.text,
              backgroundColor: palette.background,
            }
          : {}),
        version: template.version + 1,
      });
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'certificate_template.updated',
        targetType: 'certificate_template',
        targetId: template.id,
        targetLabel: updated.name,
        context: { version: updated.version },
      });
      return toTemplateResponse(updated);
    });
  }

  /**
   * Render a SAMPLE certificate from a DRAFT template config (unsaved), so the
   * editor's live preview is produced by the real PDF renderer — the preview
   * can never diverge from the issued PDF because it is the same code path,
   * the same layout and the same palette. Nothing is persisted.
   */
  async previewTemplate(
    academyId: string,
    organizationId: string,
    userId: string,
    dto: UpdateCertificateTemplateDto,
    locale: 'en' | 'ar',
  ): Promise<{ pdf: Buffer; warnings: readonly string[] }> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertManagingRole(tx, academyId, userId);
      const academy = await tx.academy.findUnique({
        where: { id: academyId },
        select: { name: true, slug: true, logoUrl: true },
      });
      const template = await this.ensureDefaultTemplate(
        tx,
        academyId,
        academy?.name ?? '',
        academy?.logoUrl ?? null,
      );
      const current = paletteFromTemplate(template);
      const palette = assertReadablePalette({
        primary: dto.primaryColor ?? current.primary,
        accent: dto.accentColor ?? current.accent,
        text: dto.textColor ?? current.text,
        background: dto.backgroundColor ?? current.background,
      });
      const wording = parseWording({
        en: { ...parseWording(template.wording).en, ...(dto.wording?.en ?? {}) },
        ar: { ...parseWording(template.wording).ar, ...(dto.wording?.ar ?? {}) },
      });
      const logoUrl = dto.logoUrl !== undefined ? dto.logoUrl : template.logoUrl;
      const signatureUrl =
        dto.signatureUrl !== undefined ? dto.signatureUrl : template.signatureUrl;
      const signatoryName =
        dto.signatoryName !== undefined ? dto.signatoryName : template.signatoryName;
      const signatoryTitle =
        dto.signatoryTitle !== undefined ? dto.signatoryTitle : template.signatoryTitle;
      const sample = SAMPLE_PREVIEW_DATA[locale];
      const snapshot: CertificateSnapshot = {
        learnerName: sample.learnerName,
        learnerEmailMasked: 'l•••@example.com',
        courseTitle: sample.courseTitle,
        courseSlug: 'sample-course',
        academyName: academy?.name ?? sample.academyName,
        academySlug: academy?.slug ?? 'academy',
        instructors: [sample.instructor],
        completedAt: new Date().toISOString(),
        overallScore: 96,
        scoreSummary: [],
        templateVersion: template.version,
        templateId: template.id,
        logoUrl: this.absolutePublicMediaUrl(logoUrl),
        signatureUrl: this.absolutePublicMediaUrl(signatureUrl),
        signatoryName,
        signatoryTitle,
        wording,
        palette,
        locale,
      };
      const { pdf, warnings } = await this.renderer.render({
        snapshot,
        serial: 'PREVIEW-0000-000000',
        verificationCode: 'PREVIEWCODE00',
        verificationCodeDisplay: formatVerificationCode('PREVIEWCODE00'),
        verifyUrl: `${this.publicBaseUrl()}/verify/PREVIEW`,
        issuedAt: new Date(),
        version: 1,
        locale,
      });
      return { pdf, warnings };
    });
  }

  private async ensureDefaultTemplate(
    tx: Prisma.TransactionClient,
    academyId: string,
    academyName: string,
    academyLogoUrl: string | null,
  ) {
    const existing = await this.repository.findDefaultTemplate(tx, academyId);
    if (existing) return existing;
    return this.repository.createTemplate(tx, {
      academyId,
      name: DEFAULT_TEMPLATE_NAME,
      logoUrl: academyLogoUrl,
      signatoryName: academyName || null,
      wording: {},
      isDefault: true,
    });
  }

  // ---------------------------------------------------------------------
  // render (queue)
  // ---------------------------------------------------------------------

  async renderCertificate(
    certificateId: string,
    academyId: string,
  ): Promise<'rendered' | 'failed' | 'skipped'> {
    const organizationId =
      await this.academiesRepository.resolveOrganizationId(academyId);
    if (!organizationId) return 'skipped';
    const certificate = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.repository.findById(tx, certificateId),
    );
    if (!certificate || certificate.academyId !== academyId) return 'skipped';
    const snapshot = certificate.snapshot as unknown as CertificateSnapshot;
    const locale = certificate.locale === 'ar' ? 'ar' : 'en';
    // The logo/signature may be an uploaded media reference — the app-relative
    // `/api/v1/public/media/...` path (P4 Issue 7). The renderer fetches over
    // HTTP and cannot resolve a relative path, so make them absolute against
    // the platform domain here, where that config lives, without mutating the
    // stored snapshot.
    const renderSnapshot: CertificateSnapshot = {
      ...snapshot,
      logoUrl: this.absolutePublicMediaUrl(snapshot.logoUrl),
      signatureUrl: this.absolutePublicMediaUrl(snapshot.signatureUrl),
    };
    try {
      const { pdf, warnings } = await this.renderer.render({
        snapshot: renderSnapshot,
        serial: certificate.serial,
        verificationCode: certificate.verificationCode,
        verificationCodeDisplay: formatVerificationCode(certificate.verificationCode),
        verifyUrl: this.verifyUrl(certificate.verificationCode),
        issuedAt: certificate.issuedAt,
        version: certificate.version,
        locale,
      });
      const storageKey = `academies/${academyId}/certificates/${certificate.id}/v${certificate.version}.pdf`;
      await this.storage.putObject(storageKey, pdf, 'application/pdf');
      await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
        this.repository.update(tx, certificate.id, {
          renderStatus: 'ready',
          storageKey,
          renderedAt: new Date(),
          renderError: warnings.length > 0 ? warnings.join('; ') : null,
        }),
      );
      this.metrics.recordCertificateRender(true);
      return 'rendered';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ certificateId, error: message }, 'Certificate render failed.');
      await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
        this.repository.update(tx, certificate.id, {
          renderStatus: 'failed',
          renderError: message.slice(0, 500),
        }),
      );
      this.metrics.recordCertificateRender(false);
      throw error;
    }
  }

  private async enqueueRender(certificateId: string, academyId: string): Promise<void> {
    const payload: CertificateRenderJobPayload = { certificateId, academyId };
    try {
      await this.queue.add(CERTIFICATE_RENDER_JOB, payload, {
        jobId: `certificate-render:${certificateId}:${Date.now()}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: { count: 1_000 },
      });
    } catch (error) {
      this.logger.warn(
        { certificateId, error: error instanceof Error ? error.message : String(error) },
        'Could not enqueue the certificate render; regenerate from the academy dashboard to retry.',
      );
    }
  }

  // ---------------------------------------------------------------------
  // account deletion (anonymisation)
  // ---------------------------------------------------------------------

  /**
   * On account deletion the learner's NAME is replaced on every certificate
   * they hold; the issuance facts (serial, course, date, score) stay, so a
   * verifier still learns that a certificate exists and is valid, without
   * learning who held it. Re-rendered so the PDF says the same.
   */
  async anonymizeForUser(userId: string): Promise<number> {
    const rows = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.certificate.findMany({
        where: { studentId: userId },
        select: { id: true, academyId: true },
      }),
    );
    let changed = 0;
    for (const row of rows) {
      const organizationId = await this.academiesRepository.resolveOrganizationId(
        row.academyId,
      );
      if (!organizationId) continue;
      await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
        const certificate = await this.repository.findById(tx, row.id);
        if (!certificate) return;
        const snapshot = certificate.snapshot as unknown as CertificateSnapshot;
        const anonymized: CertificateSnapshot = {
          ...snapshot,
          learnerName: certificate.locale === 'ar' ? 'حساب محذوف' : 'Deleted account',
          learnerEmailMasked: '',
          anonymizedAt: new Date().toISOString(),
        };
        await this.repository.update(tx, row.id, {
          snapshot: anonymized as unknown as Prisma.InputJsonValue,
          renderStatus: 'pending',
          storageKey: null,
          renderedAt: null,
        });
        changed += 1;
      });
      await this.enqueueRender(row.id, row.academyId);
    }
    return changed;
  }

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------

  private async assertManagingRole(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<string> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (!membership || !MANAGING_ROLES.has(membership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.certificate.insufficientRole' });
    }
    return membership.role;
  }

  private async roleOf(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<string> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    return membership?.role ?? 'staff';
  }

  /** Managing roles see the academy; instructors see the courses they teach (RBAC matrix: "View (assigned)"). */
  private async resolveStaffScope(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<StaffScope> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (membership && MANAGING_ROLES.has(membership.role))
      return { kind: 'academy', role: membership.role };
    const taught = await tx.courseInstructor.findMany({
      where: { userId, course: { academyId } },
      select: { courseId: true },
    });
    if (taught.length === 0)
      throw new ForbiddenException({ messageKey: 'errors.certificate.insufficientRole' });
    return { kind: 'courses', courseIds: taught.map((row) => row.courseId) };
  }

  private localeFor(
    preferences: unknown,
    academyDefault: string | null | undefined,
  ): 'en' | 'ar' {
    const language = (preferences as { language?: unknown } | null)?.language;
    if (language === 'ar' || language === 'en') return language;
    return academyDefault === 'ar' ? 'ar' : 'en';
  }

  verifyUrl(code: string): string {
    return `${this.publicBaseUrl()}/verify/${formatVerificationCode(code)}`;
  }

  private publicBaseUrl(): string {
    return this.platformDomain?.baseDomain
      ? `https://${this.platformDomain.baseDomain}`
      : 'http://localhost:3001';
  }

  /**
   * Resolves an uploaded-media reference (the app-relative
   * `/api/v1/public/media/...` path) to an absolute URL the renderer can
   * fetch. An already-absolute URL (an author's external logo) and null pass
   * through unchanged.
   */
  private absolutePublicMediaUrl(url: string | null): string | null {
    if (!url) return url;
    if (url.startsWith('/')) return `${this.publicBaseUrl()}${url}`;
    return url;
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '';
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

export type { CertificateWithNames };
