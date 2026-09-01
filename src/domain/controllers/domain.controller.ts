/**
 * DomainController — `academies/:id/website/domain*` (master plan §21
 * Phase P11). Same guard reuse as `WebsiteController`/
 * `WebsiteContentController` — `AcademyScopeGuard` resolves
 * `request.academyContext` before any handler runs.
 */
import { Body, Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { DomainService } from '../services/domain.service';
import { AddCustomDomainDto } from '../dto/add-custom-domain.dto';
import type { AcademyDomainConfigurationResponse } from '../dto/domain.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, AcademyScopeGuard)
export class DomainController {
  constructor(private readonly domainService: DomainService) {}

  @Get(':id/website/domain')
  async getDomainConfiguration(
    @Req() request: Request,
  ): Promise<AcademyDomainConfigurationResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.domainService.getDomainConfiguration(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Post(':id/website/domain/custom-domain')
  async addCustomDomain(
    @Req() request: Request,
    @Body() body: AddCustomDomainDto,
  ): Promise<AcademyDomainConfigurationResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.domainService.addCustomDomain(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Delete(':id/website/domain/custom-domain')
  async removeCustomDomain(
    @Req() request: Request,
  ): Promise<AcademyDomainConfigurationResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.domainService.removeCustomDomain(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Post(':id/website/domain/verify')
  async verifyDomain(
    @Req() request: Request,
  ): Promise<AcademyDomainConfigurationResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.domainService.verifyDomain(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }
}
