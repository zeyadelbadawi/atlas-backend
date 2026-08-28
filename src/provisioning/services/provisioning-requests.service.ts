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
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { PaymentsRepository } from '../../billing/repositories/payments.repository';
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
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    private readonly provisioningProducer: ProvisioningProducer,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

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

    const request = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const existing = await this.provisioningRequestsRepository.findByIdempotencyKey(
          tx,
          organizationId,
          payload.idempotencyKey,
        );
        if (existing) return existing;

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

    return this.toResponse(organizationId, request);
  }

  async getRequest(
    organizationId: string,
    requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    const request = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.provisioningRequestsRepository.findById(tx, requestId),
    );
    if (!request || request.organizationId !== organizationId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    return this.toResponse(organizationId, request);
  }

  async listRequests(
    organizationId: string,
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
      items.map((item) => this.toResponse(organizationId, item)),
    );

    return {
      items: responses,
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  /** Covers both "retry a failed step" and "resume an interrupted request" — the frontend's own single `retryProvisioning` method's doc comment: the backend, not the customer, decides what re-running the request actually means. Refused once the request has reached a real terminal state (`ready`/`cancelled`) — a genuinely failed or crash-stalled request (anything else) is always retryable. */
  async retryRequest(
    organizationId: string,
    requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    const request = await this.loadOwnedRequestOrThrow(organizationId, requestId);
    this.assertRetryable(request);

    await this.provisioningProducer.enqueue({
      provisioningRequestId: request.id,
      organizationId,
    });

    return this.toResponse(organizationId, request);
  }

  /** Cancels a still-in-progress request. Does NOT roll back an already-created Academy/subdomain allocation — a conservative, "no hard delete" choice (see `Reports/PROGRESS.md`'s P14 section for the documented reasoning), matching every other cancellation in this codebase being a status transition, never a destructive undo. */
  async cancelRequest(
    organizationId: string,
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

    return this.toResponse(organizationId, updated);
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

  private async toResponse(
    organizationId: string,
    request: ProvisioningRequest,
  ): Promise<ProvisioningRequestResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const steps = await this.provisioningStepsRepository.findAllForRequest(
        tx,
        request.id,
      );
      const subdomain = request.academyId
        ? await this.subdomainAllocationsRepository.findByAcademyId(tx, request.academyId)
        : null;
      const domainConnection = request.academyId
        ? await this.domainConnectionsRepository.findByAcademyId(tx, request.academyId)
        : null;
      return toProvisioningRequestResponse(request, steps, subdomain, domainConnection);
    });
  }
}
