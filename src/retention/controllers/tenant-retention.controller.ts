/**
 * `GET /organizations/:id/retention` — the read behind
 * `/dashboard/tenant/retention`, the page every W1-W4 warning email links
 * to (`TENANT_RETENTION_PATH` in the communication catalog).
 *
 * IT EXISTS BECAUSE THE EMAILS ALREADY POINT AT IT. C6 shipped a warning
 * sequence whose link had no destination; the first `warn_only` run would
 * have sent an owner to a 404 at the exact moment they were told their
 * content would be deleted.
 *
 * SHAPE AND GUARDS ARE `TenantSubscriptionController`'s, deliberately —
 * that controller already establishes how a tenant-scoped read under
 * `organizations/:id` is authorised in this codebase, and a second shape
 * for the same question is a second thing to get wrong:
 *
 *   `JwtAuthGuard`               who is calling
 *   `ManagementSurfaceGuard`     a learner never reaches a management read
 *   `OrganizationMembershipGuard` `:id` IS the organization id, so the P2
 *                                guard applies directly — and it verifies
 *                                membership INSIDE the RLS context it sets,
 *                                so guard and database ask the same question
 *   owner-exclusive permission   below
 *
 * WHY OWNER-ONLY, WHEN `GET :id/subscription/lifecycle` IS OPEN TO ANY
 * MEMBER. That read exposes a state and a plan name so an Instructor can
 * understand why their screens are gated. This one names the account's
 * courses, its stored minutes and the date its content is destroyed —
 * §37's "Client Owner sees ... the Data & retention page" is a scope
 * statement, and the permission below is how it is enforced rather than
 * hinted at by hiding a menu item.
 *
 * `tenant.subscription.view` is reused as that marker for exactly the
 * reason `TenantSubscriptionController` documents: permissions are
 * PERSISTED on each membership row, so a new string would be absent from
 * every row that already exists and would lock every current owner out of
 * their own retention page until a backfill ran. The property that
 * matters is exclusivity — `ORGANIZATION_OWNER_PERMISSIONS` grants it and
 * `ORGANIZATION_MANAGER_PERMISSIONS` deliberately does not.
 *
 * `@AllowInactiveSubscription()` because this page's entire audience is
 * tenants whose subscription HAS lapsed. `SubscriptionAccessInterceptor`
 * exempts GET today, so the marker changes nothing now; it is here so
 * that if that exemption is ever narrowed, the one page a lapsed customer
 * is being emailed a link to does not become the one page they cannot
 * open.
 */
import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { AllowInactiveSubscription } from '../../plans/decorators/allow-inactive-subscription.decorator';
import { TenantRetentionViewService } from '../services/tenant-retention-view.service';
import type { TenantRetentionResponse } from '../dto/tenant-retention.contract';

/** Owner-exclusive. See the header for why this string and not a new one. */
const RETENTION_VIEW_PERMISSION = 'tenant.subscription.view';

@AllowInactiveSubscription()
@Controller('organizations')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, OrganizationMembershipGuard)
export class TenantRetentionController {
  constructor(private readonly service: TenantRetentionViewService) {}

  @Get(':id/retention')
  async getRetention(
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<TenantRetentionResponse> {
    /*
      A member of another organisation never arrives here — the membership
      guard refuses them first, and the service's own reads run under this
      organisation's RLS context regardless. A member of THIS organisation
      who is not its owner is refused on the next line.
    */
    const permissions = request.tenantContext?.permissions ?? [];
    if (!permissions.includes(RETENTION_VIEW_PERMISSION)) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }

    return this.service.describe(id, request.authContext!.userId);
  }
}
