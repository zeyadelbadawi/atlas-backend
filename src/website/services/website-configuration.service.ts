/**
 * WebsiteConfigurationService — matches the real frontend
 * `WebsiteConfigurationService`'s configuration-half exactly:
 * `getConfiguration`/`updateConfiguration`/`publishConfiguration`.
 *
 * Every method independently re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantContext`, matching every other service
 * in this codebase's "never trust the guard's own read" discipline.
 *
 * Write authorization mirrors `CoursesService`/`MediaService`'s
 * `assertCanManage` exactly: organization membership alone is
 * READ-sufficient (`AcademyScopeGuard`), WRITE (update/publish) requires
 * an `academy_members` row with role `owner`/`administrator`.
 *
 * `brand`/`seo` are partial merges onto the existing stored JSON (matching
 * `UpdateWebsiteConfigurationPayload.brand`/`.seo` being `Partial<...>`),
 * the same shallow-merge-then-validate-the-result discipline
 * `AcademiesService.update` already established for `Academy.address`.
 * `navigation`/`header`/`footer` are full replaces (their payload fields
 * are NOT `Partial<...>`), validated directly.
 *
 * Publish (master plan §21 P9: "must NOT implement yet: public
 * rendering") is deliberately minimal and deterministic — there is
 * nothing to render yet (P11's job), so this sets `status = 'published'`,
 * `publishedAt = now()` synchronously in the same request, with no queue,
 * no worker, no `'publishing'` intermediate state. `'publishing'`/`'failed'`
 * remain real, valid enum values (matching the frontend's
 * `WebsitePublishStatus` type exactly) for a future P11 async
 * render-worker to use — this phase just never produces them itself.
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { WebsiteConfigurationRepository } from '../repositories/website-configuration.repository';
import { WebsiteBootstrapService } from './website-bootstrap.service';
import { SectionReferenceValidatorService } from './section-reference-validator.service';
import {
  toWebsiteConfigurationResponse,
  type WebsiteConfigurationResponse,
} from '../dto/website-configuration.contract';
import type { UpdateWebsiteConfigurationDto } from '../dto/update-website-configuration.dto';
import {
  websiteBrandPatchSchema,
  websiteBrandSchema,
  websiteFooterSchema,
  websiteHeaderSchema,
  websiteNavigationSchema,
  globalSeoSchema,
} from '../validation/website-config.schemas';
import { parseOrThrow } from '../../common/validation/zod-violations.util';

const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

@Injectable()
export class WebsiteConfigurationService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly websiteConfigurationRepository: WebsiteConfigurationRepository,
    private readonly websiteBootstrapService: WebsiteBootstrapService,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly sectionReferenceValidatorService: SectionReferenceValidatorService,
  ) {}

  private async assertCanManage(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (!membership || !MANAGING_ROLES.has(membership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.website.insufficientRole' });
    }
  }

  async getConfiguration(
    academyId: string,
    organizationId: string,
  ): Promise<WebsiteConfigurationResponse> {
    const configuration = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.websiteBootstrapService.ensureConfiguration(tx, academyId),
    );
    return toWebsiteConfigurationResponse(configuration);
  }

  async updateConfiguration(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UpdateWebsiteConfigurationDto,
  ): Promise<WebsiteConfigurationResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const current = await this.websiteBootstrapService.ensureConfiguration(
        tx,
        academyId,
      );

      const data: Prisma.WebsiteConfigurationUpdateInput = {};

      if (payload.themeKey !== undefined) {
        data.themeKey = payload.themeKey;
      }

      if (payload.brand !== undefined) {
        const patch = parseOrThrow(websiteBrandPatchSchema, payload.brand);
        const merged = { ...(current.brand as Record<string, unknown>), ...patch };
        data.brand = parseOrThrow(websiteBrandSchema, merged);
      }

      if (payload.seo !== undefined) {
        const patch = parseOrThrow(globalSeoSchema, payload.seo);
        data.seo = { ...(current.seo as Record<string, unknown>), ...patch };
      }

      if (payload.navigation !== undefined) {
        data.navigation = parseOrThrow(websiteNavigationSchema, payload.navigation);
      }

      if (payload.header !== undefined) {
        data.header = parseOrThrow(websiteHeaderSchema, payload.header);
      }

      if (payload.footer !== undefined) {
        data.footer = parseOrThrow(websiteFooterSchema, payload.footer);
      }

      await this.sectionReferenceValidatorService.validateConfigurationReferences(
        tx,
        academyId,
        {
          navigation: (data.navigation as { pageId: string }[] | undefined) ?? undefined,
          header: (data.header as { cta?: { pageId?: string } } | undefined) ?? undefined,
          footer:
            (data.footer as
              | {
                  groups?: { links?: { pageId?: string }[] }[];
                  socialLinks?: { pageId?: string }[];
                }
              | undefined) ?? undefined,
        },
      );

      const updated = await this.websiteConfigurationRepository.update(
        tx,
        academyId,
        data,
      );
      return toWebsiteConfigurationResponse(updated);
    });
  }

  async publishConfiguration(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<WebsiteConfigurationResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      await this.websiteBootstrapService.ensureConfiguration(tx, academyId);

      const updated = await this.websiteConfigurationRepository.update(tx, academyId, {
        status: 'published',
        publishedAt: new Date(),
        lastPublishError: Prisma.JsonNull,
        configVersion: { increment: 1 },
      });
      return toWebsiteConfigurationResponse(updated);
    });
  }
}
