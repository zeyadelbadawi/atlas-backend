/**
 * SuppressionService — the do-not-mail list (`communication_suppressions`).
 *
 * Keyed on SHA-256 of the CANONICAL address (trimmed, lower-cased — the
 * same `normalizeEmail` sign-in uses), never the address itself, so the
 * table leaks nothing if read. Fed by provider webhooks (hard bounce and
 * complaint → permanent; soft bounce → 30 days) and by the platform
 * console (`manual`).
 *
 * RLS: the table is platform data — SELECT/UPDATE/DELETE require a
 * platform owner's user context (`communication_suppressions_platform_all`);
 * INSERT is open (`_system_insert`). Every read here therefore runs in the
 * first platform owner's context, the precedent `Phase2MaintenanceService`
 * set for platform-wide maintenance. With no platform owner account yet
 * there is nothing to protect either: `isSuppressed` answers `false` and
 * says so once in the log.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  CommunicationSuppression,
  CommunicationSuppressionReason,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { IdentityResolver } from '../../identity/repositories/identity-resolver';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { normalizeEmail } from '../../identity/utils/email.util';

export const SOFT_BOUNCE_SUPPRESSION_DAYS = 30;

export function hashEmail(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function domainOf(email: string): string | null {
  const at = normalizeEmail(email).lastIndexOf('@');
  return at === -1 ? null : normalizeEmail(email).slice(at + 1);
}

export interface SuppressInput {
  readonly email: string;
  readonly reason: CommunicationSuppressionReason;
  /** `webhook:brevo`, `webhook:resend`, `console`, ... */
  readonly source: string;
  readonly note?: string;
  /** Omit for the reason's default: permanent for hard bounce/complaint/invalid/manual, 30 days for soft bounce. */
  readonly expiresAt?: Date | null;
}

@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);
  private warnedNoOwner = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly identityResolver: IdentityResolver,
  ) {}

  async isSuppressed(email: string, now = new Date()): Promise<boolean> {
    const ownerId = await this.platformOwnerId();
    if (!ownerId) return false;
    const emailHash = hashEmail(email);
    const row = await this.tenancyContextService.runInUserContext(ownerId, (tx) =>
      tx.communicationSuppression.findUnique({
        where: { emailHash },
        select: { expiresAt: true },
      }),
    );
    if (!row) return false;
    return row.expiresAt === null || row.expiresAt > now;
  }

  /** Upsert: a later, stronger reason (permanent) replaces a temporary one; a temporary one never shortens a permanent suppression. */
  async suppress(input: SuppressInput, now = new Date()): Promise<void> {
    const emailHash = hashEmail(input.email);
    const emailDomain = domainOf(input.email);
    const expiresAt =
      input.expiresAt !== undefined ? input.expiresAt : defaultExpiry(input.reason, now);
    const ownerId = await this.platformOwnerId();
    const upsert = (tx: Prisma.TransactionClient) =>
      tx.communicationSuppression.upsert({
        where: { emailHash },
        create: {
          emailHash,
          emailDomain,
          reason: input.reason,
          source: input.source,
          note: input.note,
          expiresAt,
        },
        update: {
          reason: input.reason,
          source: input.source,
          note: input.note,
          // Never let a 30-day soft bounce shorten a permanent block.
          ...(expiresAt === null ? { expiresAt: null } : {}),
        },
      });
    if (ownerId) {
      await this.tenancyContextService.runInUserContext(ownerId, upsert);
      return;
    }
    // No owner → RLS allows INSERT only. Try the insert; a duplicate means
    // the row already exists and (being unreadable) is left untouched.
    try {
      await this.prisma.communicationSuppression.create({
        data: {
          emailHash,
          emailDomain,
          reason: input.reason,
          source: input.source,
          note: input.note,
          expiresAt,
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
    }
  }

  async unsuppress(email: string): Promise<boolean> {
    const ownerId = await this.platformOwnerId();
    if (!ownerId) return false;
    const emailHash = hashEmail(email);
    const result = await this.tenancyContextService.runInUserContext(ownerId, (tx) =>
      tx.communicationSuppression.deleteMany({ where: { emailHash } }),
    );
    return result.count > 0;
  }

  async list(
    options: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<readonly CommunicationSuppression[]> {
    const ownerId = await this.platformOwnerId();
    if (!ownerId) return [];
    const take = Math.min(Math.max(options.limit ?? 50, 1), 200);
    return this.tenancyContextService.runInUserContext(ownerId, (tx) =>
      tx.communicationSuppression.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
      }),
    );
  }

  private async platformOwnerId(): Promise<string | null> {
    // `users` is not readable without a context (authentication audit,
    // Decision 2); the resolver returns the id and nothing else.
    const ownerId = await this.identityResolver.platformOwnerId();
    const owner = ownerId ? { id: ownerId } : null;
    if (owner) return owner.id;
    if (!this.warnedNoOwner) {
      this.warnedNoOwner = true;
      this.logger.warn(
        'No platform owner account exists yet — suppression reads are skipped.',
      );
    }
    return null;
  }
}

export function defaultExpiry(
  reason: CommunicationSuppressionReason,
  now: Date,
): Date | null {
  if (reason === 'soft_bounce') {
    return new Date(now.getTime() + SOFT_BOUNCE_SUPPRESSION_DAYS * 24 * 60 * 60 * 1000);
  }
  return null;
}
