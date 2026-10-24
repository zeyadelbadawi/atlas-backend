/**
 * Atlas mobile app (B4) — consent records (`user_consents`).
 *
 * Append-only and own-rows-only (FORCE RLS, no UPDATE policy; DELETE only by
 * account deletion): every acceptance adds rows, the latest per kind counts.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { ConsentsDto } from './consents.dto';

export const CONSENT_KINDS = ['terms', 'privacy', 'age_13_plus'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/** The wording version recorded for the 13+ confirmation. */
export const AGE_CONFIRMATION_VERSION = 'age-13-plus-v1';

export interface ConsentRecord {
  readonly version: string;
  readonly source: string;
  readonly acceptedAt: string;
}

export type ConsentSummary = Readonly<Record<ConsentKind, ConsentRecord | null>>;

function rowsFor(userId: string, input: ConsentsDto) {
  return [
    { userId, kind: 'terms', version: input.termsVersion, source: input.source },
    { userId, kind: 'privacy', version: input.privacyVersion, source: input.source },
    {
      userId,
      kind: 'age_13_plus',
      version: AGE_CONFIRMATION_VERSION,
      source: input.source,
    },
  ];
}

/**
 * Inside the registration transaction, under the new user's own
 * `app.current_user_id` (set by the caller) — the account and its consents
 * exist together or not at all.
 */
export async function createConsentsForNewAccount(
  tx: Prisma.TransactionClient,
  userId: string,
  input: ConsentsDto,
): Promise<void> {
  await tx.userConsent.createMany({ data: rowsFor(userId, input) });
}

@Injectable()
export class UserConsentService {
  constructor(private readonly tenancyContextService: TenancyContextService) {}

  /** Records a new acceptance for the caller's own account. */
  async recordOwn(userId: string, input: ConsentsDto): Promise<ConsentSummary> {
    await this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.userConsent.createMany({ data: rowsFor(userId, input) }),
    );
    return this.latestOwn(userId);
  }

  /** The latest acceptance per kind, or `null` where there is none. */
  async latestOwn(userId: string): Promise<ConsentSummary> {
    const rows = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.userConsent.findMany({
        where: { userId },
        orderBy: { acceptedAt: 'desc' },
        take: 60,
      }),
    );
    const summary: Record<ConsentKind, ConsentRecord | null> = {
      terms: null,
      privacy: null,
      age_13_plus: null,
    };
    for (const row of rows) {
      const kind = row.kind as ConsentKind;
      if (CONSENT_KINDS.includes(kind) && summary[kind] === null) {
        summary[kind] = {
          version: row.version,
          source: row.source,
          acceptedAt: row.acceptedAt.toISOString(),
        };
      }
    }
    return summary;
  }
}
