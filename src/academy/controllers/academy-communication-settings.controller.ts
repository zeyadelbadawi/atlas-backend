/**
 * `GET academies/:id/communication-settings` — the communication settings
 * in force for one academy, read-only (cloud remediation, finding G; see
 * `CommunicationSettingsViewService` for why nothing here is editable yet).
 *
 * Reading is Owner/Manager, the audience the Academy Settings card was
 * built for: the organization owner or manager, or an active academy
 * owner/administrator/manager. Instructors and staff are refused.
 */
import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../guards/academy-scope.guard';
import { CommunicationSettingsViewService } from '../../communications/services/communication-settings-view.service';
import type { AcademyCommunicationSettingsView } from '../../communications/services/communication-settings-view.service';

const READ_ROLES = new Set([
  'owner',
  'manager',
  'academy_owner',
  'academy_administrator',
  'academy_manager',
]);

@Controller('academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class AcademyCommunicationSettingsController {
  constructor(private readonly communicationSettings: CommunicationSettingsViewService) {}

  @Get(':id/communication-settings')
  get(@Req() request: Request): AcademyCommunicationSettingsView {
    if (!READ_ROLES.has(request.academyContext!.organizationRole)) {
      throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
    }
    return this.communicationSettings.academy();
  }
}
