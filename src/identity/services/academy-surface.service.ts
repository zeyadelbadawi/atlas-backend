/**
 * AcademySurfaceService — P64 Phase 1 (master plan AD-5, D3, Finding F1/F4).
 *
 * The academy-website surface needs three facts before any session or
 * account exists: which academy the request host resolves to, what that
 * academy's registration policy is, and whether an invite token is valid.
 * All three are read through SECURITY DEFINER functions (the same public
 * facts the anonymous website resolver already serves), so this service
 * needs no tenant context and no organization membership.
 *
 * Host verification is the important part: a caller may claim any
 * `academyId`; the request's `Host` header is what the edge actually routed
 * to, so on a real academy host the two must agree. Local development and
 * the platform host itself cannot be resolved to an academy and are let
 * through — the preview parameter the frontend uses there carries the id.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AcademyRegistrationPolicy } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';
import {
  extractSubdomainLabel,
  normalizeHostname,
} from '../../public-website/utils/hostname-normalization.util';
import { hashOpaqueToken } from '../utils/opaque-token.util';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

@Injectable()
export class AcademySurfaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private baseDomain(): string | undefined {
    return this.configService.get<PlatformDomainRuntimeConfig>('platformDomain')
      ?.baseDomain;
  }

  /** The academy the request host serves, or `null` when the host is the platform itself, local, or unknown. */
  async resolveHostAcademyId(rawHostname: string | undefined): Promise<string | null> {
    const normalized = normalizeHostname(rawHostname);
    if (!normalized) return null;
    const bare = normalized.split(':')[0];
    if (LOCAL_HOSTS.has(bare)) return null;
    const base = this.baseDomain();
    if (base && bare === base) return null;
    const label = extractSubdomainLabel(bare, base) ?? (bare.includes('.') ? null : bare);
    const rows = await this.prisma.$queryRaw<{ academy_id: string }[]>(
      Prisma.sql`SELECT academy_id FROM resolve_public_hostname(${bare}, ${label})`,
    );
    return rows[0]?.academy_id ?? null;
  }

  /** `true` when the host is local or the platform host — where the frontend supplies the academy through its preview parameter. */
  async isUnresolvableHost(rawHostname: string | undefined): Promise<boolean> {
    const normalized = normalizeHostname(rawHostname);
    if (!normalized) return true;
    const bare = normalized.split(':')[0];
    if (LOCAL_HOSTS.has(bare)) return true;
    const base = this.baseDomain();
    return !!base && bare === base;
  }

  /**
   * A caller-supplied `academyId` must be the academy the request host
   * serves. On an unresolvable host (local, platform host) the id is taken
   * as given — there is nothing to compare against; on a real academy host
   * a mismatch is refused.
   */
  async assertAcademyMatchesHost(
    academyId: string,
    rawHostname: string | undefined,
  ): Promise<void> {
    if (await this.isUnresolvableHost(rawHostname)) return;
    const hostAcademyId = await this.resolveHostAcademyId(rawHostname);
    if (hostAcademyId && hostAcademyId !== academyId) {
      throw new ForbiddenException({ messageKey: 'errors.auth.academyHostMismatch' });
    }
  }

  async registrationPolicy(academyId: string): Promise<AcademyRegistrationPolicy> {
    const rows = await this.prisma.$queryRaw<
      { policy: AcademyRegistrationPolicy | null }[]
    >(Prisma.sql`SELECT resolve_academy_registration_policy(${academyId}) AS policy`);
    const policy = rows[0]?.policy;
    if (!policy) {
      throw new NotFoundException({ messageKey: 'errors.academy.notFound' });
    }
    return policy;
  }

  /** Redeems one use of an invite token atomically; `false` when unknown, expired, revoked or exhausted. */
  async claimInvite(academyId: string, rawToken: string | undefined): Promise<boolean> {
    if (!rawToken) return false;
    const rows = await this.prisma.$queryRaw<{ claimed: boolean }[]>(
      Prisma.sql`SELECT claim_academy_invite(${academyId}, ${hashOpaqueToken(rawToken)}) AS claimed`,
    );
    return rows[0]?.claimed === true;
  }

  /**
   * Applies the registration policy to a brand-new learner: returns the
   * membership status the new `academy_students` row must carry, or throws
   * the policy's refusal.
   */
  async admissionForNewLearner(
    academyId: string,
    inviteToken: string | undefined,
  ): Promise<{ status: 'active' | 'pending'; source: 'self_signup' | 'invite' }> {
    const policy = await this.registrationPolicy(academyId);
    switch (policy) {
      case 'open':
        return { status: 'active', source: 'self_signup' };
      case 'approval':
        return { status: 'pending', source: 'self_signup' };
      case 'invite': {
        if (!inviteToken) {
          throw new ForbiddenException({ messageKey: 'errors.auth.inviteRequired' });
        }
        const claimed = await this.claimInvite(academyId, inviteToken);
        if (!claimed) {
          throw new BadRequestException({ messageKey: 'errors.auth.inviteInvalid' });
        }
        return { status: 'active', source: 'invite' };
      }
    }
  }
}
