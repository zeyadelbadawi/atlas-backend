/**
 * ProvisioningRequestsService — `organizations/:id/provisioning-requests*`,
 * the org-scoped entry point matching `ProvisioningService` (atlas
 * frontend) exactly: create/get/list/retry/cancel, no more.
 *
 * `createRequest` is idempotent on `(organizationId, idempotencyKey)` —
 * master plan §10's "every financial mutation accepts and enforces a
 * client-supplied idempotency key" convention, checked BEFORE attempting a
 * create, and again via a `P2002` catch as a race-safe fallback — the
 * exact `CheckoutService.createCheckout` precedent. The 7-step row set is
 * initialized inside the SAME transaction as the request row itself, so
 * the two can never exist independently of each other.
 *
 * Creation only ENQUEUES the orchestrator job — it never runs a step
 * inline. This keeps the HTTP response fast and matches §12's `Service →
 * domain event → BullMQ → idempotent worker` rule; the frontend's own
 * `PROVISIONING_STATUS_POLL_INTERVAL_MS` polling loop is what actually
 * observes progress.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { cleanDisplayName } from '../../common/name-uniqueness/name-key';
import {
  academyNameTaken,
  isAcademyNameTaken,
  requireNameKey,
} from '../../common/name-uniqueness/name-uniqueness';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import { PaymentsRepository } from '../../billing/repositories/payments.repository';
import { TenantSubscriptionsRepository } from '../../plans/repositories/tenant-subscriptions.repository';
import { resolveEffectiveSubscriptionStatus } from '../../plans/utils/subscription-effective-status.util';
import { PLANS_CLOCK, type Clock } from '../../plans/utils/clock';
import { SubdomainAllocationsRepository } from '../../domain/repositories/subdomain-allocations.repository';
import { DomainConnectionsRepository } from '../../domain/repositories/domain-connections.repository';
import { ProvisioningRequestsRepository } from '../repositories/provisioning-requests.repository';
import { ProvisioningStepsRepository } from '../repositories/provisioning-steps.repository';
import { ProvisioningProducer } from '../queue/provisioning.producer';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { MediaAssetsRepository } from '../../media/repositories/media-assets.repository';
import { toMediaAssetUrl } from '../../media/dto/media-asset.contract';
import { WebsiteConfigurationService } from '../../website/services/website-configuration.service';
import { DEFAULT_WEBSITE_THEME_KEY } from '../../website/constants/website.constants';
import type { ProvisioningConfig } from '../../config/configuration';
import { ProvisioningOrchestratorService } from './provisioning-orchestrator.service';
import {
  DEFAULT_PROVISIONING_STALL_SECONDS,
  RESERVED_SUBDOMAINS,
  TERMINAL_PROVISIONING_STATUSES,
} from '../dto/provisioning.constants';
import {
  parseRequestedBrand,
  readRequestedBrand,
  type RequestedBrand,
} from '../dto/requested-brand';
import { parseRequestedPaymentMethods } from '../dto/requested-payment-methods';
import {
  toProvisioningRequestResponse,
  type ProvisioningRequestResponse,
} from '../dto/provisioning-request.contract';
import type { CreateProvisioningRequestDto } from '../dto/create-provisioning-request.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { ProvisioningRequest } from '@prisma/client';

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class ProvisioningRequestsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly provisioningRequestsRepository: ProvisioningRequestsRepository,
    private readonly provisioningStepsRepository: ProvisioningStepsRepository,
    private readonly paymentsRepository: PaymentsRepository,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    private readonly provisioningProducer: ProvisioningProducer,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly organizationMembershipsRepository: OrganizationMembershipsRepository,
    @Inject(PLANS_CLOCK) private readonly clock: Clock,
    private readonly provisioningOrchestratorService: ProvisioningOrchestratorService,
    private readonly mediaAssetsRepository: MediaAssetsRepository,
    private readonly websiteConfigurationService: WebsiteConfigurationService,
    private readonly configService: ConfigService,
  ) {}

  private stallThresholdSeconds(): number {
    return (
      this.configService.get<ProvisioningConfig>('provisioning')?.stallThresholdSeconds ??
      DEFAULT_PROVISIONING_STALL_SECONDS
    );
  }

  /**
   * Only an Organization OWNER may start provisioning.
   *
   * Mirrors `AcademiesService`'s `CREATES_ACADEMY_ROLES` exactly. Read
   * inside the tenant context so the membership lookup is itself
   * RLS-scoped — a caller cannot be granted a role they do not hold by
   * pointing at another organization.
   */
  private async assertCanCreateAcademy(
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      (tx) =>
        this.organizationMembershipsRepository.findForUserInOrganization(
          tx,
          organizationId,
          userId,
        ),
    );

    if (!membership || membership.role !== 'owner') {
      throw new ForbiddenException({
        messageKey: 'errors.academy.insufficientRole',
      });
    }
  }

  async createRequest(
    organizationId: string,
    userId: string,
    payload: CreateProvisioningRequestDto,
  ): Promise<ProvisioningRequestResponse> {
    if (RESERVED_SUBDOMAINS.includes(payload.requestedSubdomain)) {
      throw new ConflictException({
        messageKey: 'errors.provisioning.subdomainReserved',
      });
    }

    // SECURITY — creating an Academy is OWNER-ONLY, and that must be
    // decided HERE, not eight asynchronous steps later.
    //
    // Found by the Phase 11 security pass: `OrganizationMembershipGuard`
    // proves the caller belongs to the organization but says nothing
    // about their ROLE, so a Manager or an Instructor could submit a
    // provisioning request and receive 201. No Academy was ever created —
    // `AcademiesService.create` enforces the same owner-only rule inside
    // the orchestrator — but the refusal arrived asynchronously, on a
    // request row the caller was never entitled to create, and the API
    // told them "accepted". An authorization boundary that only holds in
    // a background worker is one refactor away from not holding at all.
    //
    // Same `MANAGING/CREATES_ACADEMY_ROLES` rule as the orchestrator's
    // own check, applied synchronously. The orchestrator's check is
    // deliberately NOT removed: two independent enforcement points for
    // one rule is the point.
    await this.assertCanCreateAcademy(organizationId, userId);

    // W2 — the brand is validated synchronously (400 with field
    // violations: strict keys, hex/triplet colours, an accessible palette,
    // never a data: URI) before anything is written.
    const requestedBrand = parseRequestedBrand(payload.brand, userId);
    // Academy Manual Payments — normalised (and blank details refused)
    // before anything is written, like the brand.
    const requestedPaymentMethods = parseRequestedPaymentMethods(payload.paymentMethods);

    // An address another Academy already holds is refused at once, rather
    // than three steps into the background run — unless this is a replay
    // of a request that already allocated it. Checked OUTSIDE the create
    // transaction: `existsBySubdomain` is a global lookup on its own pooled
    // connection, and must not hold a transaction open while it waits.
    const replay = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.provisioningRequestsRepository.findByIdempotencyKey(
          tx,
          organizationId,
          payload.idempotencyKey,
        ),
    );
    if (
      !replay &&
      (await this.subdomainAllocationsRepository.existsBySubdomain(
        payload.requestedSubdomain,
      ))
    ) {
      throw new ConflictException({
        messageKey: 'errors.provisioning.subdomainUnavailable',
        code: 'subdomain_unavailable',
      });
    }

    const outcome = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const existing = await this.provisioningRequestsRepository.findByIdempotencyKey(
          tx,
          organizationId,
          payload.idempotencyKey,
        );
        if (existing) return { request: existing, created: false };

        // W2 — ONE ADDRESS, ONE REQUEST. Two tabs (two forms, two
        // idempotency keys) asking for the same address used to create two
        // rows; the second's academy step then adopted the first's Academy
        // and died on a unique constraint, retried, and opened a support
        // ticket. Now the create is serialized per address (a transaction
        // advisory lock, released at commit) and the loser gets a clear
        // 409 carrying the winner's request id, so the page can follow it.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`provisioning-subdomain:${payload.requestedSubdomain}`}, 0))`;
        // The lock may have been waiting on a concurrent submit of the SAME
        // key (a double click): that is a replay, not a second tab.
        const sameKey = await this.provisioningRequestsRepository.findByIdempotencyKey(
          tx,
          organizationId,
          payload.idempotencyKey,
        );
        if (sameKey) return { request: sameKey, created: false };
        const active = await this.provisioningRequestsRepository.findActiveBySubdomain(
          tx,
          organizationId,
          payload.requestedSubdomain,
        );
        if (active) {
          throw new ConflictException({
            messageKey: 'errors.provisioning.subdomainRequestInProgress',
            code: 'subdomain_request_in_progress',
            details: { requestId: active.id },
          });
        }

        // W4 — academy names are unique platform-wide. Checked HERE, when
        // the request is made, so a clash is an immediate 409 on the form
        // rather than an asynchronous failed step after a 201. (A name taken
        // between now and the worker's run is not a failure either: the
        // worker takes the first free "<name> (2)" — see
        // `AcademiesService.create`'s `suffix` policy.)
        const academyNameKey = await requireNameKey(
          tx,
          cleanDisplayName(payload.academyName),
          'academyName',
        );
        if (await isAcademyNameTaken(tx, academyNameKey, null)) {
          throw academyNameTaken('academyName');
        }

        // Phase P19 (`Reports/DEVELOPMENT_E2E_FLOW_AUDIT.md` P1-2):
        // previously, `triggeringPaymentId` was optional and, even when
        // supplied, only checked for existence — never that a real,
        // active subscription actually resulted from it. Provisioning
        // must not be startable merely by knowing an organization id.
        // Checking the Organization's real subscription state (rather
        // than re-deriving a specific payment's own success) is the
        // simpler, more robust gate: it holds regardless of which payment
        // (or future payment provider) produced the subscription, and it
        // is exactly the state `PaymentApplicationService.
        // applyCommercialEffect` establishes the moment a Payment is
        // actually approved (see that file's own doc comment — "the one
        // and only server-side trigger").
        const subscription =
          await this.tenantSubscriptionsRepository.findByOrganizationId(
            tx,
            organizationId,
          );
        // A LAPSED TRIAL IS NOT AN ACTIVE ONE. `status === 'trialing'`
        // alone was accepted here, so an organization whose trial had
        // already ended could still start provisioning — the refusal
        // arrived asynchronously, from `EntitlementEnforcementService`
        // inside the orchestrator, after the API had already answered
        // 201. The scheduled sweep normally flips a lapsed trial to
        // `expired`, but "normally" is doing too much work in an
        // authorization check: between the trial ending and the sweep
        // running, this gate was open. Checking `trialEndsAt` directly
        // closes that window rather than depending on a background job
        // having run.
        //
        // Expiry enforcement generalised that to every dated state: the
        // EFFECTIVE status decides, so a paid period past its grace end
        // (or a cancel-at-period-end past its period end) is refused here
        // the instant the clock says so, and a `grace_period` tenant —
        // still entitled, still paying — is not.
        const effectiveStatus = subscription
          ? resolveEffectiveSubscriptionStatus(subscription, this.clock.now())
              .effectiveStatus
          : null;

        if (
          effectiveStatus !== 'active' &&
          effectiveStatus !== 'trialing' &&
          effectiveStatus !== 'grace_period'
        ) {
          throw new ConflictException({
            messageKey: 'errors.provisioning.subscriptionRequired',
          });
        }

        if (payload.triggeringPaymentId) {
          const payment = await this.paymentsRepository.findById(
            tx,
            organizationId,
            payload.triggeringPaymentId,
          );
          if (!payment) {
            throw new NotFoundException({
              messageKey: 'errors.provisioning.paymentNotFound',
            });
          }
        }

        try {
          const created = await this.provisioningRequestsRepository.create(tx, {
            organizationId,
            requestedByUserId: userId,
            requestedAcademyName: payload.academyName,
            requestedSubdomain: payload.requestedSubdomain,
            triggeringPaymentId: payload.triggeringPaymentId,
            // W2 — the platform default theme when none was picked: the
            // website is always built (see `executeThemeStep`).
            selectedThemeKey: payload.selectedThemeKey ?? DEFAULT_WEBSITE_THEME_KEY,
            websiteSetupMode: payload.websiteSetupMode,
            requestedBrand: requestedBrand
              ? (requestedBrand as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull,
            requestedPaymentMethods: requestedPaymentMethods
              ? (requestedPaymentMethods as Prisma.InputJsonValue)
              : Prisma.DbNull,
            idempotencyKey: payload.idempotencyKey,
          });
          await this.provisioningStepsRepository.initializeForRequest(tx, created.id);

          // Phase P15 retroactive audit coverage — same transaction as
          // the request/step rows above; never written on the idempotent
          // replay branches (`if (existing) return existing;` above, or
          // the `P2002`-race catch below), since those genuinely create
          // nothing new to audit.
          await this.auditLogWriterService.write(tx, {
            actorUserId: userId,
            organizationId,
            action: 'provisioning_request.created',
            targetType: 'provisioning_request',
            targetId: created.id,
            targetLabel: created.requestedAcademyName,
          });

          return { request: created, created: true };
        } catch (error) {
          // Two concurrent replays of the same idempotency key raced the
          // check above — the unique constraint is the real authority;
          // re-read and return the row the OTHER request created, never a
          // duplicate (matches `CheckoutService.createCheckout`'s identical
          // precedent).
          if (isUniqueConstraintViolation(error)) {
            const raced = await this.provisioningRequestsRepository.findByIdempotencyKey(
              tx,
              organizationId,
              payload.idempotencyKey,
            );
            if (raced) return { request: raced, created: false };
          }
          throw error;
        }
      },
    );

    const { request, created: isNew } = outcome;

    // An idempotent replay of a request that already finished (or failed)
    // must not quietly retry it — only a new request, or a replay of one
    // still in flight (re-enqueueing is a no-op if its job is queued), is
    // (re)enqueued. Retrying a failed request is the explicit `retry` call.
    if (isNew || !TERMINAL_PROVISIONING_STATUSES.has(request.status)) {
      await this.provisioningProducer.enqueue({
        provisioningRequestId: request.id,
        organizationId,
      });
    }

    return this.toResponse(organizationId, userId, request);
  }

  async getRequest(
    organizationId: string,
    userId: string,
    requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    const request = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.provisioningRequestsRepository.findById(tx, requestId),
    );
    if (!request || request.organizationId !== organizationId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return this.toResponse(organizationId, userId, request);
  }

  async listRequests(
    organizationId: string,
    userId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<ProvisioningRequestResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.provisioningRequestsRepository.findManyForOrganization(tx, organizationId, {
          search: query.search,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    const responses = await Promise.all(
      items.map((item) => this.toResponse(organizationId, userId, item)),
    );

    return {
      items: responses,
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  /** Covers both "retry a failed step" and "resume an interrupted request" — the frontend's own single `retryProvisioning` method's doc comment: the backend, not the customer, decides what re-running the request actually means. Refused once the request has reached a real terminal state (`ready`/`cancelled`) — a genuinely failed or crash-stalled request (anything else) is always retryable. */
  async retryRequest(
    organizationId: string,
    userId: string,
    requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    const request = await this.loadOwnedRequestOrThrow(organizationId, requestId);

    // W2 — a ready Academy whose branding could not be applied: re-run
    // just that step, now (one transaction), and answer with the result.
    if (request.status === 'ready') {
      const retried = await this.provisioningOrchestratorService.retryBrandingStep(
        request.id,
        organizationId,
      );
      if (!retried) {
        throw new ConflictException({ messageKey: 'errors.provisioning.notRetryable' });
      }
      const fresh = await this.loadOwnedRequestOrThrow(organizationId, requestId);
      return this.toResponse(organizationId, userId, fresh);
    }

    this.assertRetryable(request);

    await this.provisioningProducer.enqueue({
      provisioningRequestId: request.id,
      organizationId,
    });

    return this.toResponse(organizationId, userId, request);
  }

  /**
   * W2 — attaches the setup form's logo to the request once the Academy
   * exists. The page uploads the file to the new Academy's media library
   * (the existing, authorized, quota-checked upload) and sends only the
   * resulting media-asset id; the asset must be an active image of THIS
   * request's Academy. The reference is stored on `requested_brand` (so
   * the `branding` step — or a later retry of it — applies it too) and the
   * logo is applied at once through `saveVisualIdentity`, as the caller:
   * idempotent, it sets the same logo URL again on a repeat.
   */
  async attachLogo(
    organizationId: string,
    userId: string,
    requestId: string,
    mediaAssetId: string,
  ): Promise<ProvisioningRequestResponse> {
    await this.assertCanCreateAcademy(organizationId, userId);
    const request = await this.loadOwnedRequestOrThrow(organizationId, requestId);
    if (request.status === 'cancelled') {
      throw new ConflictException({ messageKey: 'errors.provisioning.notRetryable' });
    }
    if (!request.academyId) {
      throw new ConflictException({ messageKey: 'errors.provisioning.academyNotReady' });
    }
    const academyId = request.academyId;

    const asset = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      (tx) => this.mediaAssetsRepository.findById(tx, academyId, mediaAssetId),
    );
    if (!asset || asset.type !== 'image' || asset.status !== 'active') {
      throw new BadRequestException({
        messageKey: 'errors.validation.failed',
        violations: [
          { field: 'mediaAssetId', messageKey: 'errors.provisioning.logoAssetInvalid' },
        ],
      });
    }

    // The same relative public-media URL the media library hands out
    // (and the Brand tab stores), never the raw object-store URL.
    const logoUrl = toMediaAssetUrl(asset.storageKey);
    const current = readRequestedBrand(request.requestedBrand);
    const next: RequestedBrand = {
      ...(current?.palette ? { palette: current.palette } : {}),
      logo: { status: 'attached', mediaAssetId: asset.id, url: logoUrl },
    };
    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      this.provisioningRequestsRepository.update(tx, request.id, {
        requestedBrand: next as unknown as Prisma.InputJsonValue,
      }),
    );

    await this.websiteConfigurationService.saveVisualIdentity(
      academyId,
      organizationId,
      userId,
      { logo: logoUrl },
    );

    const fresh = await this.loadOwnedRequestOrThrow(organizationId, requestId);
    return this.toResponse(organizationId, userId, fresh);
  }

  /** Cancels a still-in-progress request. Does NOT roll back an already-created Academy/subdomain allocation — a conservative, "no hard delete" choice (see `Reports/PROGRESS.md`'s P14 section for the documented reasoning), matching every other cancellation in this codebase being a status transition, never a destructive undo. */
  async cancelRequest(
    organizationId: string,
    userId: string,
    requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    await this.loadOwnedRequestOrThrow(organizationId, requestId);

    const updated = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const fresh = await this.provisioningRequestsRepository.findById(tx, requestId);
        if (!fresh) throw new NotFoundException({ messageKey: 'errors.notFound' });
        if (TERMINAL_PROVISIONING_STATUSES.has(fresh.status)) {
          throw new ConflictException({
            messageKey: 'errors.provisioning.notCancellable',
          });
        }
        return this.provisioningRequestsRepository.update(tx, requestId, {
          status: 'cancelled',
        });
      },
    );

    return this.toResponse(organizationId, userId, updated);
  }

  private async loadOwnedRequestOrThrow(
    organizationId: string,
    requestId: string,
  ): Promise<ProvisioningRequest> {
    const request = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.provisioningRequestsRepository.findById(tx, requestId),
    );
    if (!request || request.organizationId !== organizationId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return request;
  }

  private assertRetryable(request: ProvisioningRequest): void {
    if (request.status === 'ready' || request.status === 'cancelled') {
      throw new ConflictException({ messageKey: 'errors.provisioning.notRetryable' });
    }
  }

  /**
   * `userId` (Phase 1, Extended Scope, dependency A) — the subdomain/
   * domain reads below are now RLS-gated on `is_academy_member`, not just
   * organization membership; the caller's own real identity is threaded
   * through so an org member who also holds the real (auto-granted)
   * academy_members row for the Academy this request created — always
   * true for whoever actually requested it — keeps seeing the exact same
   * detail as before. A caller with no such membership degrades
   * gracefully (subdomain/domainConnection read as `null`, the base
   * provisioning status is still returned) rather than throwing — this
   * endpoint's own guard (`OrganizationMembershipGuard`) remains
   * organization-level by design; this only narrows what the ADDITIONAL
   * website/domain detail exposes, never the request's own visibility.
   */
  private async toResponse(
    organizationId: string,
    userId: string,
    request: ProvisioningRequest,
  ): Promise<ProvisioningRequestResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const steps = await this.provisioningStepsRepository.findAllForRequest(
          tx,
          request.id,
        );
        const subdomain = request.academyId
          ? await this.subdomainAllocationsRepository.findByAcademyId(
              tx,
              request.academyId,
            )
          : null;
        const domainConnection = request.academyId
          ? await this.domainConnectionsRepository.findByAcademyId(tx, request.academyId)
          : null;
        const progress = {
          now: new Date(),
          stallThresholdSeconds: this.stallThresholdSeconds(),
        };
        return toProvisioningRequestResponse(
          request,
          steps,
          subdomain,
          domainConnection,
          progress,
        );
      },
    );
  }
}
