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
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import { PaymentsRepository } from '../../billing/repositories/payments.repository';
import { TenantSubscriptionsRepository } from '../../plans/repositories/tenant-subscriptions.repository';
import { SubdomainAllocationsRepository } from '../../domain/repositories/subdomain-allocations.repository';
import { DomainConnectionsRepository } from '../../domain/repositories/domain-connections.repository';
import { ProvisioningRequestsRepository } from '../repositories/provisioning-requests.repository';
import { ProvisioningStepsRepository } from '../repositories/provisioning-steps.repository';
import { ProvisioningProducer } from '../queue/provisioning.producer';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import {
  RESERVED_SUBDOMAINS,
  TERMINAL_PROVISIONING_STATUSES,
} from '../dto/provisioning.constants';
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
  ) {}

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

    const request = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const existing = await this.provisioningRequestsRepository.findByIdempotencyKey(
          tx,
          organizationId,
          payload.idempotencyKey,
        );
        if (existing) return existing;

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
        const trialHasLapsed =
          subscription?.status === 'trialing' &&
          subscription.trialEndsAt !== null &&
          subscription.trialEndsAt.getTime() <= Date.now();

        if (
          !subscription ||
          (subscription.status !== 'active' && subscription.status !== 'trialing') ||
          trialHasLapsed
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
            selectedThemeKey: payload.selectedThemeKey,
            websiteSetupMode: payload.websiteSetupMode,
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

          return created;
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
            if (raced) return raced;
          }
          throw error;
        }
      },
    );

    await this.provisioningProducer.enqueue({
      provisioningRequestId: request.id,
      organizationId,
    });

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
    this.assertRetryable(request);

    await this.provisioningProducer.enqueue({
      provisioningRequestId: request.id,
      organizationId,
    });

    return this.toResponse(organizationId, userId, request);
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
        return toProvisioningRequestResponse(request, steps, subdomain, domainConnection);
      },
    );
  }
}
