/**
 * P64 Phase 3 (§L) — certificate routes.
 *
 *   Learner (academy surface, JWT):
 *     GET  /learning/certificates                 { enabled, items }
 *     GET  /learning/certificates/:id             detail + download link when rendered
 *     GET  /learning/certificates/:id/download    { url, expiresAt } (1-hour signed link)
 *   Public (no auth, rate-limited, uniform timing):
 *     GET  /verify/:code
 *   Staff (JWT + management surface + academy scope):
 *     GET  /academies/:id/certificates
 *     GET  /academies/:id/certificates/:certificateId
 *     POST /academies/:id/certificates/:certificateId/revoke
 *     POST /academies/:id/certificates/:certificateId/regenerate
 *     POST /academies/:id/enrollments/:enrollmentId/certificate
 *     GET  /academies/:id/certificate-template
 *     PUT  /academies/:id/certificate-template
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { AcademySurfaceService } from '../../identity/services/academy-surface.service';
import { CertificatesService } from '../services/certificates.service';
import {
  IssueCertificateDto,
  ListCertificatesQueryDto,
  RegenerateCertificateDto,
  RevokeCertificateDto,
  UpdateCertificateTemplateDto,
} from '../dto/certificate.dto';
import type {
  CertificateDownloadResponse,
  CertificateResponse,
  CertificateTemplateResponse,
  CertificateVerificationResponse,
} from '../dto/certificate.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('learning/certificates')
@UseGuards(JwtAuthGuard)
export class LearnerCertificatesController {
  constructor(
    private readonly certificates: CertificatesService,
    private readonly academySurfaceService: AcademySurfaceService,
  ) {}

  @Get()
  async list(
    @Req() request: Request,
  ): Promise<{ enabled: boolean; items: CertificateResponse[] }> {
    const academyId = await this.requireHostAcademy(request);
    return this.certificates.listForLearner(request.authContext!.userId, academyId);
  }

  @Get(':certificateId')
  @Header('Cache-Control', 'private, no-store')
  async get(
    @Req() request: Request,
    @Param('certificateId') certificateId: string,
  ): Promise<CertificateResponse & { download: CertificateDownloadResponse | null }> {
    return this.certificates.getForLearner(request.authContext!.userId, certificateId);
  }

  @Get(':certificateId/download')
  @Header('Cache-Control', 'private, no-store')
  async download(
    @Req() request: Request,
    @Param('certificateId') certificateId: string,
  ): Promise<CertificateDownloadResponse> {
    return this.certificates.downloadForLearner(
      request.authContext!.userId,
      certificateId,
    );
  }

  /** Mirrors `LearnerDashboardController.requireHostAcademy`: the academy is the request host, with a query fallback for local development. */
  private async requireHostAcademy(request: Request): Promise<string> {
    const hostAcademyId = await this.academySurfaceService.resolveHostAcademyId(
      request.hostname,
    );
    if (hostAcademyId) return hostAcademyId;
    const fallback = (request.query as Record<string, unknown>).academyId;
    if (typeof fallback === 'string' && fallback.length > 0) return fallback;
    throw new BadRequestException({ messageKey: 'errors.academy.hostUnresolved' });
  }
}

@Controller('verify')
export class CertificateVerificationController {
  constructor(private readonly certificates: CertificatesService) {}

  /** Public. 30 lookups per minute per IP; uniform timing; never a 404 (unknown = `valid: false`). */
  @Get(':code')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  async verify(@Param('code') code: string): Promise<CertificateVerificationResponse> {
    return this.certificates.verify(code);
  }
}

@Controller('academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class AcademyCertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get(':id/certificates')
  async list(
    @Req() request: Request,
    @Query() query: ListCertificatesQueryDto,
  ): Promise<PaginatedResult<CertificateResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.certificates.listForAcademy(
      academyId,
      organizationId,
      request.authContext!.userId,
      query,
    );
  }

  @Get(':id/certificates/:certificateId')
  @Header('Cache-Control', 'private, no-store')
  async get(
    @Req() request: Request,
    @Param('certificateId') certificateId: string,
  ): Promise<CertificateResponse & { download: CertificateDownloadResponse | null }> {
    const { academyId, organizationId } = request.academyContext!;
    return this.certificates.getForAcademy(
      academyId,
      organizationId,
      request.authContext!.userId,
      certificateId,
    );
  }

  @Post(':id/certificates/:certificateId/revoke')
  @HttpCode(200)
  async revoke(
    @Req() request: Request,
    @Param('certificateId') certificateId: string,
    @Body() body: RevokeCertificateDto,
  ): Promise<CertificateResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.certificates.revoke(
      academyId,
      organizationId,
      request.authContext!.userId,
      certificateId,
      body,
    );
  }

  @Post(':id/certificates/:certificateId/regenerate')
  @HttpCode(200)
  async regenerate(
    @Req() request: Request,
    @Param('certificateId') certificateId: string,
    @Body() body: RegenerateCertificateDto,
  ): Promise<CertificateResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.certificates.regenerate(
      academyId,
      organizationId,
      request.authContext!.userId,
      certificateId,
      body,
    );
  }

  @Post(':id/enrollments/:enrollmentId/certificate')
  @HttpCode(201)
  async issue(
    @Req() request: Request,
    @Param('enrollmentId') enrollmentId: string,
    @Body() body: IssueCertificateDto,
  ): Promise<CertificateResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.certificates.issueManually(
      academyId,
      organizationId,
      request.authContext!.userId,
      enrollmentId,
      body,
    );
  }

  @Get(':id/certificate-template')
  async getTemplate(@Req() request: Request): Promise<CertificateTemplateResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.certificates.getTemplate(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Put(':id/certificate-template')
  async updateTemplate(
    @Req() request: Request,
    @Body() body: UpdateCertificateTemplateDto,
  ): Promise<CertificateTemplateResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.certificates.updateTemplate(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }
}
