/**
 * Moving an Academy's public address when its slug changes (owner
 * decision, 20 Oct 2026: "move + old address redirects").
 *
 * The slug IS the Atlas subdomain label. Saving a new one used to change
 * only `academies.slug`, while the public website, email links and invite
 * links all follow `subdomain_allocations` — so the site stayed on the old
 * address and the new one opened nothing. `move` runs inside the caller's
 * slug-update transaction and:
 *
 *   - moves the allocation (label and full host) to the new label — or
 *     creates it, for an Academy that never had one;
 *   - keeps the previous label as an alias of this Academy for good: its
 *     host keeps answering, with a redirect to the Academy's canonical
 *     host (`PublicWebsiteService.resolveHostname`), and no other Academy
 *     can take it (the namespace triggers of migration
 *     `20261123000000_subdomain_aliases`);
 *   - when the new label is one of the Academy's own old addresses, that
 *     alias row is re-pointed at the label being given up, so the old name
 *     becomes the address again and nothing is ever freed.
 *
 * A previous label that is a reserved platform word (an Academy that held
 * it before DL-57 reserved it) is NOT kept: it goes back to the platform.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma, SubdomainAllocation } from '@prisma/client';
import { SubdomainAllocationsRepository } from '../../domain/repositories/subdomain-allocations.repository';
import { SubdomainAliasesRepository } from '../../domain/repositories/subdomain-aliases.repository';
import { buildFullHost } from '../../domain/utils/effective-base-domain.util';
import { isReservedSubdomain } from '../../provisioning/dto/provisioning.constants';

export interface AcademyAddressMoveInput {
  readonly academyId: string;
  /** The new slug — already validated, length- and reserved-checked by the caller. */
  readonly subdomain: string;
  /** The effective platform base domain, when one is in force. */
  readonly baseDomain: string | undefined;
}

export interface AcademyAddressMoveResult {
  /** The allocation before the move; `null` when the Academy had none. */
  readonly previous: SubdomainAllocation | null;
  readonly allocation: SubdomainAllocation;
  /** The previous label stays held by this Academy and redirects to its address. */
  readonly redirectKept: boolean;
  /** The new label was one of this Academy's old addresses. */
  readonly reclaimedAlias: boolean;
  /** Every old address this Academy holds after the move (for cache invalidation). */
  readonly aliases: readonly string[];
}

@Injectable()
export class AcademyAddressService {
  constructor(
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly subdomainAliasesRepository: SubdomainAliasesRepository,
  ) {}

  async move(
    tx: Prisma.TransactionClient,
    input: AcademyAddressMoveInput,
  ): Promise<AcademyAddressMoveResult> {
    const { academyId, subdomain, baseDomain } = input;
    const previous = await this.subdomainAllocationsRepository.findByAcademyId(
      tx,
      academyId,
    );
    const fullHost = buildFullHost(subdomain, baseDomain);

    if (previous?.subdomain === subdomain) {
      // Already there (a repaired row): nothing moves, nothing is kept.
      return {
        previous,
        allocation: previous,
        redirectKept: false,
        reclaimedAlias: false,
        aliases: await this.aliasLabels(tx, academyId),
      };
    }

    const reclaimed = await this.subdomainAliasesRepository.findForAcademy(
      tx,
      academyId,
      subdomain,
    );
    const allocation = previous
      ? await this.subdomainAllocationsRepository.moveTo(tx, academyId, {
          subdomain,
          fullHost,
        })
      : await this.subdomainAllocationsRepository.create(tx, {
          academyId,
          subdomain,
          status: 'assigned',
          fullHost,
        });

    const previousLabel = previous?.subdomain ?? null;
    let redirectKept = false;
    if (previousLabel !== null && !isReservedSubdomain(previousLabel)) {
      const alreadyKept = await this.subdomainAliasesRepository.findForAcademy(
        tx,
        academyId,
        previousLabel,
      );
      if (!alreadyKept) {
        if (reclaimed) {
          await this.subdomainAliasesRepository.rename(tx, reclaimed.id, previousLabel);
        } else {
          await this.subdomainAliasesRepository.create(tx, {
            academyId,
            subdomain: previousLabel,
          });
        }
      }
      redirectKept = true;
    }

    return {
      previous,
      allocation,
      redirectKept,
      reclaimedAlias: reclaimed !== null,
      aliases: await this.aliasLabels(tx, academyId),
    };
  }

  private async aliasLabels(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<string[]> {
    const rows = await this.subdomainAliasesRepository.findAllForAcademy(tx, academyId);
    return rows.map((row) => row.subdomain);
  }
}
