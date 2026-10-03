/**
 * OrganizationsService — the P2 self-service surface (master plan §21
 * Phase P2). See the P2 final report for why this is deliberately narrow:
 * no frontend `OrganizationService` exists to derive a fuller contract
 * from (`TenantService` is billing/usage, Phase P4/P12 scope;
 * `PlatformOrganizationService` is the cross-tenant Platform Owner view,
 * Phase P15 scope — neither is this phase's).
 */
import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Organization } from '@prisma/client';
import { TenancyContextService } from './tenancy-context.service';
import { OrganizationsRepository } from '../repositories/organizations.repository';
import { OrganizationMembershipsRepository } from '../repositories/organization-memberships.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { ORGANIZATION_OWNER_PERMISSIONS } from '../constants/organization-permissions.constants';
import { toOrganizationResponse } from '../dto/organization.contract';
import type { OrganizationResponse } from '../dto/organization.contract';
import type { CreateOrganizationDto } from '../dto/create-organization.dto';
import { cleanDisplayName } from '../../common/name-uniqueness/name-key';
import {
  isOrganizationNameTaken,
  lockOrganizationName,
  organizationNameUnavailable,
  requireNameKey,
} from '../../common/name-uniqueness/name-uniqueness';

/** Kebab-cases a name into a slug candidate — same shape as every other slug this codebase generates from a human-entered name (Academy's own client-supplied slug convention, applied here server-side since Organization creation has no dedicated slug field in its UI). */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'organization'
  );
}

/**
 * `organizations` has three unique constraints: `id` (the primary key — a
 * fresh `randomUUID()` per call here, not realistically collidable), `slug`
 * and, since W4, `name_key`. `error.meta.target` is NOT reliably populated
 * by Postgres/Prisma for every `P2002` (confirmed empirically against this
 * exact code path — it surfaced as "Unique constraint failed on the (not
 * available)", no target array at all), so a P2002 is CLASSIFIED rather
 * than inspected: `createInTransaction` asks `organization_name_taken`
 * again after rolling the attempt back, and only a conflict that is not the
 * name is treated as a slug collision.
 */
function isUniqueSlugViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Bounded — a real name collision should never be able to loop forever; this many attempts is generous for what is, in practice, always a same-name-twice edge case. */
const MAX_SLUG_ATTEMPTS = 5;

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationsRepository: OrganizationsRepository,
    private readonly organizationMembershipsRepository: OrganizationMembershipsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  /**
   * Phase P19 — real Organization creation
   * (`Reports/DEVELOPMENT_E2E_FLOW_AUDIT.md` P0-1: previously missing
   * entirely, `POST /organizations` returned a real 404). The caller
   * becomes the Organization's `owner_user_id` AND its first
   * `organization_memberships` row (`role: 'owner'`), in one transaction,
   * with a real, non-empty permission set (closing P0-2 in the same
   * stroke — see `organization-permissions.constants.ts`). RLS
   * choreography documented on `OrganizationsRepository.create`.
   *
   * `onCreated` (Phase 2 addition) — an optional extra step run INSIDE
   * the exact same transaction, given the already-open `tx` and the
   * freshly-created `Organization` row, immediately after the owner
   * membership/audit-log write above. Exists so `PlansModule`'s
   * `OrganizationsController` (which now owns the real `POST
   * /organizations` route — see that module's own doc comment for why)
   * can atomically bootstrap the new Organization's trial subscription
   * without this service ever importing anything from `PlansModule`
   * itself: `TenancyModule` stays exactly as dependency-free as it always
   * was (see this module's own header comment on the DAG this keeps
   * clean) — a plain callback parameter, no new module import, no new
   * injection token, the caller supplies the cross-cutting behavior. A
   * caller that omits it (every other, non-Phase-2 call site, and every
   * pre-existing test) gets byte-identical behavior to before this
   * parameter existed.
   */
  async create(
    userId: string,
    payload: CreateOrganizationDto,
    onCreated?: (
      tx: Prisma.TransactionClient,
      organization: Organization,
    ) => Promise<void>,
  ): Promise<OrganizationResponse> {
    const organizationId = randomUUID();
    const organization = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      (tx) =>
        this.createInTransaction(
          tx,
          { organizationId, userId, name: payload.name },
          onCreated,
        ),
    );
    return toOrganizationResponse(organization);
  }

  /**
   * The body of `create`, runnable inside a transaction the CALLER owns —
   * New Customer Onboarding's signup creates the account, the Organization,
   * its subscription and its trial in ONE transaction
   * (docs/NEW_CUSTOMER_ONBOARDING.md §3.2), so it cannot open its own.
   *
   * The caller must already have set `app.current_organization_id` to
   * `organizationId` and `app.current_user_id` to `userId` on `tx` — exactly
   * what `runInTenantAndUserContext` does for `create` above.
   *
   * SLUG RETRY WITHOUT LOSING THE TRANSACTION. A unique-slug violation
   * aborts a Postgres transaction, so each attempt runs inside a SAVEPOINT
   * and a collision rolls back only that attempt. `create` used to open a
   * fresh transaction per attempt instead; the outcome is identical.
   *
   * `onboardingCompletedAt: null` is passed ONLY by the signup path — every
   * other caller omits it and the column's default marks the organization as
   * already onboarded.
   */
  async createInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly organizationId: string;
      readonly userId: string;
      readonly name: string;
      readonly onboardingCompletedAt?: null;
      /** W4 — the request field a name conflict is reported on (`organizationName` at signup). */
      readonly nameField?: string;
    },
    onCreated?: (
      tx: Prisma.TransactionClient,
      organization: Organization,
    ) => Promise<void>,
  ): Promise<Organization> {
    const { organizationId, userId } = input;
    const name = cleanDisplayName(input.name);
    const nameField = input.nameField ?? 'name';
    const baseSlug = slugify(name);

    // W4 — organization names are unique platform-wide. Lock the key for the
    // rest of this transaction, then ask the boolean definer check (RLS hides
    // every other tenant's row from this context). The answer is generic on
    // purpose: it never says who holds the name.
    const nameKey = await requireNameKey(tx, name, nameField);
    await lockOrganizationName(tx, nameKey);
    if (await isOrganizationNameTaken(tx, nameKey)) {
      throw organizationNameUnavailable(nameField);
    }

    let created: Organization | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && !created; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomUUID().slice(0, 6)}`;
      await tx.$executeRawUnsafe('SAVEPOINT organization_slug_attempt');
      try {
        created = await this.organizationsRepository.create(tx, {
          id: organizationId,
          name,
          slug,
          ownerUserId: userId,
          onboardingCompletedAt: input.onboardingCompletedAt,
        });
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT organization_slug_attempt');
      } catch (error) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT organization_slug_attempt');
        if (!isUniqueSlugViolation(error)) throw error;
        // W4 — a name conflict (a writer that skipped the lock above) is
        // never retried as a slug collision: five slug retries would end in
        // a raw P2002 and a 500.
        if (await isOrganizationNameTaken(tx, nameKey)) {
          throw organizationNameUnavailable(nameField);
        }
        lastError = error;
      }
    }
    if (!created) throw lastError;

    // Clear any existing primary flag(s) for this user first — see
    // `clearPrimaryForUser`'s own doc comment for the real bug this
    // prevents (multiple `isPrimary: true` memberships accumulating
    // across successive org-creation events).
    await this.organizationMembershipsRepository.clearPrimaryForUser(tx, userId);

    await this.organizationMembershipsRepository.create(tx, {
      organizationId: created.id,
      userId,
      role: 'owner',
      permissions: ORGANIZATION_OWNER_PERMISSIONS,
      isPrimary: true,
    });

    await this.auditLogWriterService.write(tx, {
      actorUserId: userId,
      organizationId: created.id,
      action: 'organization.created',
      targetType: 'organization',
      targetId: created.id,
      targetLabel: created.name,
    });

    if (onCreated) {
      await onCreated(tx, created);
    }

    return created;
  }

  /**
   * Independently re-establishes the RLS tenant context and re-reads the
   * row, rather than trusting the row `OrganizationMembershipGuard` already
   * fetched for its own membership check — this is deliberate: it's what
   * makes RLS a genuinely independent third layer (master plan §7 point 2)
   * instead of a guard-layer decision the database merely rubber-stamps.
   */
  async getById(organizationId: string): Promise<OrganizationResponse> {
    const organization = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.organizationsRepository.findById(tx, organizationId),
    );

    if (!organization) {
      // Structurally unreachable if `OrganizationMembershipGuard` ran first
      // (it already proved a membership row exists in this exact tenant
      // context) — kept as a real check, not an assertion, because a
      // service method must never assume its own guard always precedes it.
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    return toOrganizationResponse(organization);
  }
}
