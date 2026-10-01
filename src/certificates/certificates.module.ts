/**
 * P64 Phase 3 (§D.6) — CertificatesModule.
 *
 * Imports `AuthCoreModule` (JwtAuthGuard), `TenancyModule`
 * (TenancyContextService, ManagementSurfaceGuard), `AcademyModule`
 * (AcademyScopeGuard, repositories), `MediaModule` (the protected
 * storage the PDFs live in), `FlagsModule` and `IdentityModule`
 * (AcademySurfaceService for the learner host). `LearningModule` is NOT
 * imported: the completion evaluator talks to this module only through
 * the BullMQ queue, which keeps the module graph acyclic.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AcademyModule } from '../academy/academy.module';
import { MediaModule } from '../media/media.module';
import { FlagsModule } from '../common/flags/flags.module';
import { CertificatesRepository } from './certificates.repository';
import { CertificatesService } from './services/certificates.service';
import { CertificateRendererService } from './services/certificate-renderer.service';
import { CertificateImageLoader } from './services/certificate-image-loader.service';
import { CertificateJobsProcessor } from './queue/certificate-jobs.processor';
import { CERTIFICATE_JOBS_QUEUE } from './queue/certificate-jobs.types';
import {
  AcademyCertificatesController,
  CertificateVerificationController,
  LearnerCertificatesController,
} from './controllers/certificates.controllers';

@Module({
  imports: [
    AuthCoreModule,
    IdentityModule,
    TenancyModule,
    AcademyModule,
    MediaModule,
    FlagsModule,
    BullModule.registerQueue({ name: CERTIFICATE_JOBS_QUEUE }),
  ],
  controllers: [
    LearnerCertificatesController,
    CertificateVerificationController,
    AcademyCertificatesController,
  ],
  providers: [
    CertificatesRepository,
    CertificatesService,
    CertificateRendererService,
    CertificateImageLoader,
    CertificateJobsProcessor,
  ],
  exports: [CertificatesService],
})
export class CertificatesModule {}
