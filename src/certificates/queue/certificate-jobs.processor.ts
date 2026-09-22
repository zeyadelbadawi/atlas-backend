import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  CERTIFICATE_ISSUE_JOB,
  CERTIFICATE_JOBS_QUEUE,
  CERTIFICATE_RENDER_CONCURRENCY,
  CERTIFICATE_RENDER_JOB,
  CERTIFICATE_ANONYMIZE_JOB,
  type CertificateAnonymizeJobPayload,
  type CertificateIssueJobPayload,
  type CertificateRenderJobPayload,
} from './certificate-jobs.types';
import { CertificatesService } from '../services/certificates.service';

/**
 * P64 Phase 3 (§D.6) — issuance checks and PDF renders. Both idempotent:
 * an issuance re-checks eligibility and finds an existing row; a render of
 * an already-rendered version simply overwrites the same object key.
 */
@Processor(CERTIFICATE_JOBS_QUEUE, { concurrency: CERTIFICATE_RENDER_CONCURRENCY })
export class CertificateJobsProcessor extends WorkerHost {
  private readonly logger = new Logger(CertificateJobsProcessor.name);

  constructor(private readonly certificates: CertificatesService) {
    super();
  }

  async process(
    job: Job<
      | CertificateIssueJobPayload
      | CertificateRenderJobPayload
      | CertificateAnonymizeJobPayload
    >,
  ): Promise<void> {
    if (job.name === CERTIFICATE_ANONYMIZE_JOB) {
      const { userId } = job.data as CertificateAnonymizeJobPayload;
      const changed = await this.certificates.anonymizeForUser(userId);
      this.logger.log({ userId, changed }, 'Certificate anonymisation processed.');
      return;
    }
    if (job.name === CERTIFICATE_ISSUE_JOB) {
      const { enrollmentId, academyId } = job.data as CertificateIssueJobPayload;
      const outcome = await this.certificates.issueAutomatically(enrollmentId, academyId);
      this.logger.log({ enrollmentId, outcome }, 'Certificate issuance check processed.');
      return;
    }
    if (job.name === CERTIFICATE_RENDER_JOB) {
      const { certificateId, academyId } = job.data as CertificateRenderJobPayload;
      const outcome = await this.certificates.renderCertificate(certificateId, academyId);
      this.logger.log({ certificateId, outcome }, 'Certificate render processed.');
      return;
    }
    this.logger.warn({ name: job.name }, 'Unknown certificate job ignored.');
  }
}
