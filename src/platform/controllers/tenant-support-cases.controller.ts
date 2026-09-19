/**
 * TenantSupportCasesController — Phase 8's tenant-facing counterpart to
 * `SupportCasesController` (which stays exactly as it was: Platform-Owner
 * only, no create route — see its own doc comment). This controller adds
 * the create-a-ticket / track-my-tickets surface the roadmap calls for,
 * mounted under the SAME route-scoping convention every other tenant
 * write in this codebase already uses (`organizations/:id/...`/
 * `academies/:id/...`, reusing `OrganizationMembershipGuard`/
 * `AcademyScopeGuard` verbatim) rather than a bare `support-cases` path —
 * that bare path is already owned by the Platform-Owner-only controller,
 * and every other tenant-scoped resource in this backend is mounted this
 * same way (`organizations/:id/provisioning-requests`, `academies/:id/
 * members`, ...), so this follows the existing convention instead of
 * inventing a second one.
 *
 * Two parallel route groups, not one: an Organization Owner's ticket has
 * no single Academy (`academyId: null`); an Academy Manager's ticket is
 * scoped to the one Academy they manage. Both funnel into the same
 * `SupportCasesService.createCase`/`listMyCases`, which is what actually
 * enforces "you may only ever see/create your own ticket" via the real,
 * independent RLS policies those methods run under — this controller's
 * job is only resolving `organizationId`/`academyId`/`role` from whichever
 * guard ran, never a second authorization decision of its own.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { SupportCasesService } from '../services/support-cases.service';
import { CreateSupportCaseDto } from '../dto/create-support-case.dto';
import { ListSupportCasesQueryDto } from '../dto/list-support-cases-query.dto';
import { PostSupportCaseReplyDto } from '../dto/post-support-case-reply.dto';
import type {
  SupportCaseDetailResponse,
  SupportCaseSummaryResponse,
} from '../dto/support-case.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { AllowInactiveSubscription } from '../../plans/decorators/allow-inactive-subscription.decorator';

/**
 * ALLOWED WHILE A SUBSCRIPTION IS INACTIVE.
 *
 * A customer whose subscription lapsed is exactly the customer most
 * likely to need support. Locking them out of the ticket form is how a
 * billing problem becomes a churn event.
 */
@AllowInactiveSubscription()
@Controller()
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard)
export class TenantSupportCasesController {
  constructor(private readonly supportCasesService: SupportCasesService) {}

  @Post('organizations/:id/support-cases')
  @UseGuards(OrganizationMembershipGuard)
  async createForOrganization(
    @Req() request: Request,
    @Body() body: CreateSupportCaseDto,
  ): Promise<SupportCaseDetailResponse> {
    const { organizationId, role } = request.tenantContext!;
    return this.supportCasesService.createCase(
      organizationId,
      request.authContext!.userId,
      null,
      role,
      body,
    );
  }

  @Get('organizations/:id/support-cases')
  @UseGuards(OrganizationMembershipGuard)
  async listMineForOrganization(
    @Req() request: Request,
    @Query() query: ListSupportCasesQueryDto,
  ): Promise<PaginatedResult<SupportCaseSummaryResponse>> {
    return this.supportCasesService.listMyCases(request.authContext!.userId, query);
  }

  @Post('academies/:id/support-cases')
  @UseGuards(AcademyScopeGuard)
  async createForAcademy(
    @Req() request: Request,
    @Body() body: CreateSupportCaseDto,
  ): Promise<SupportCaseDetailResponse> {
    const { academyId, organizationId, organizationRole } = request.academyContext!;
    return this.supportCasesService.createCase(
      organizationId,
      request.authContext!.userId,
      academyId,
      organizationRole,
      body,
    );
  }

  @Get('academies/:id/support-cases')
  @UseGuards(AcademyScopeGuard)
  async listMineForAcademy(
    @Req() request: Request,
    @Query() query: ListSupportCasesQueryDto,
  ): Promise<PaginatedResult<SupportCaseSummaryResponse>> {
    return this.supportCasesService.listMyCases(request.authContext!.userId, query);
  }

  /**
   * Phase 11.8 — reading one of MY tickets, with its conversation.
   *
   * NOT MOUNTED UNDER `organizations/:id` OR `academies/:id`, unlike the
   * create and list routes above, and that is deliberate. A ticket
   * belongs to the PERSON who filed it, not to a tenant the caller is
   * currently looking at — `listMyCases` already works the same way,
   * returning a requester's tickets across every organization they belong
   * to. Requiring a tenant prefix here would mean a customer could not
   * open a ticket they had filed from an academy they have since left,
   * and would add a second, weaker authorization path to a resource whose
   * real boundary is the requester-scoped RLS policy.
   *
   * `JwtAuthGuard` establishes WHO is asking;
   * `support_cases_requester_select` decides what exists for them. A case
   * id belonging to anyone else returns 404, never 403 — a 403 would
   * confirm that the id is a real ticket.
   */
  @Get('support-cases/mine/:caseId')
  async getMine(
    @Req() request: Request,
    @Param('caseId') caseId: string,
  ): Promise<SupportCaseDetailResponse> {
    return this.supportCasesService.getMyCase(request.authContext!.userId, caseId);
  }

  /**
   * Phase 11.8 — continuing the conversation on my own ticket.
   *
   * The reply is always recorded as `requester`; the RLS policy
   * independently refuses any other `author_role` from a tenant
   * connection, so a customer cannot fabricate an official Atlas reply
   * even if the service were changed.
   */
  @Post('support-cases/mine/:caseId/messages')
  async replyToMine(
    @Req() request: Request,
    @Param('caseId') caseId: string,
    @Body() body: PostSupportCaseReplyDto,
  ): Promise<SupportCaseDetailResponse> {
    return this.supportCasesService.postRequesterReply(
      request.authContext!.userId,
      caseId,
      body,
    );
  }

  /**
   * P53 — serving a ticket attachment's bytes.
   *
   * AUTHENTICATED, UNLIKE `PublicMediaController`, and that difference is
   * the whole security design. Academy logos and hero images are meant to
   * be readable by anonymous visitors, so media rides an unguessable-URL
   * capability. A support ticket is private to the one person who filed it
   * — `support_cases_requester_select` says so — and a screenshot of that
   * person's billing page or broken screen inherits that privacy. So this
   * route carries `JwtAuthGuard` (established at the class level) and
   * `getAttachmentBytes` resolves the row under the CALLER's own RLS
   * context, where the requester and platform-owner policies decide.
   *
   * MOUNTED HERE, NOT UNDER `organizations/:id`/`academies/:id`, for the
   * same reason `getMine` is: an attachment belongs to a person's ticket,
   * not to whichever tenant they happen to be viewing — and a ticket filed
   * from an academy they have since left must still open.
   *
   * ONE ROUTE FOR BOTH AUDIENCES. A Platform Owner reading a customer's
   * ticket fetches the same path; `..._platform_select` is what grants it.
   * A second agent-facing route would be a second authorization surface
   * for one rule.
   */
  @Get('support-cases/attachments/:attachmentId')
  // No caching. Media's immutable one-year cache is correct for public,
  // capability-addressed bytes; a private attachment must not sit in a
  // shared or disk cache after the session that fetched it ends.
  @Header('Cache-Control', 'private, no-store')
  async serveAttachment(
    @Req() request: Request,
    @Param('attachmentId') attachmentId: string,
    @Res() response: Response,
  ): Promise<void> {
    if (!UUID_PATTERN.test(attachmentId)) {
      throw new BadRequestException({ messageKey: 'errors.validation.failed' });
    }

    const { buffer, mimeType } = await this.supportCasesService.getAttachmentBytes(
      request.authContext!.userId,
      attachmentId,
    );

    response.setHeader('Content-Type', mimeType);
    response.setHeader('Content-Length', buffer.byteLength);
    // The stored `mimeType` is the one `detectFileKind` sniffed from the
    // real bytes, never a client claim — but `nosniff` still stops a
    // browser re-interpreting it, matching `PublicMediaController`.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    // The file name is display-only and never addresses storage; it is not
    // echoed into a header at all, so a crafted name cannot influence
    // `Content-Disposition` parsing. The image renders inline.
    response.end(buffer);
  }
}

/** A v4 UUID — the shape of every attachment id. Matches `PublicMediaController`'s own parameter guard. */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
