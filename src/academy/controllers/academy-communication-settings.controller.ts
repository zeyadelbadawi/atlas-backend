/**
 * `GET academies/:id/communication-settings` — the communication settings
 * in force for one academy, read-only (cloud remediation, finding G; see
 * `CommunicationSettingsViewService` for why nothing here is editable yet).
 *
 * Reading is Owner/Manager, the audience the Academy Settings card was
 * built for: the organization owner, or an active owner/administrator/
 * manager of THIS academy. Instructors and staff are refused.
 *
 * W5 (F12) — this used to compare the ORGANIZATION role, so the manager of
 * academy A passed for every other academy of the organization. The role
 * is now the caller's role in this academy, resolved by `AcademyScopeGuard`.
 */
import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../guards/academy-scope.guard';
import {
  ACADEMY_MANAGING_ROLES,
  AcademyRoles,
} from '../decorators/academy-roles.decorator';
import { CommunicationSettingsViewService } from '../../communications/services/communication-settings-view.service';
import type { AcademyCommunicationSettingsView } from '../../communications/services/communication-settings-view.service';

@Controller('academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class AcademyCommunicationSettingsController {
  constructor(private readonly communicationSettings: CommunicationSettingsViewService) {}

  @Get(':id/communication-settings')
  @AcademyRoles(...ACADEMY_MANAGING_ROLES)
  get(): AcademyCommunicationSettingsView {
    return this.communicationSettings.academy();
  }
}
