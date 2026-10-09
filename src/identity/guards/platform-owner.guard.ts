/**
 * PlatformOwnerGuard — wires `users.is_platform_owner` into the
 * authorization mechanism (master plan §21 Phase P2: "`platform_owner`
 * flag wired into the auth/authorization layer... P2 only wires the flag
 * into the authorization mechanism so later P15 can use it").
 *
 * Lives in the identity module, not the tenancy module — despite being a
 * "Phase P2 wiring" deliverable, `is_platform_owner` is a user attribute,
 * not an organization/tenancy one, and this guard's only dependency is
 * `UsersRepository`. Housing it here avoids a circular module dependency
 * between identity (needs tenancy for `CurrentUser.organizations`) and
 * tenancy (needs `JwtAuthGuard`, which lives alongside this class) — see
 * `AuthCoreModule`'s doc comment for the full reasoning.
 *
 * Deliberately unattached to any P2 route — no Platform Owner Control
 * Plane endpoint exists yet (Phase P15). Re-reads `is_platform_owner` from
 * the database on every check rather than trusting a JWT claim —
 * `platform_owner` is global and security-sensitive (master plan §9: "no
 * permission string can imply the Platform Owner role"), and P1's access
 * tokens deliberately carry no role/permission claims at all (only
 * `sub`/`sid`) precisely so a claim like this can never go stale or be
 * trusted blindly for something this sensitive.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { IdentityConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { runInUserContext } from '../../database/user-context';
import { UsersRepository } from '../repositories/users.repository';
import { surfaceDenied } from './surface-denial.util';

@Injectable()
export class PlatformOwnerGuard implements CanActivate {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.authContext?.userId;

    if (!userId) {
      throw new ForbiddenException({ messageKey: 'errors.forbidden' });
    }

    // Launch Stabilization A1 (D1) — platform administration is reachable
    // only from a session minted on the management surface, never from one
    // minted on an academy website (a tenant-operated origin). Checked here,
    // not only in `ManagementSurfaceGuard`, because not every Platform
    // Owner route carries that guard.
    if (request.authContext?.surface !== 'management') {
      throw surfaceDenied(request, 'platform_owner_route', 'errors.forbidden');
    }

    const user = await this.usersRepository.findById(userId);
    if (!user?.isPlatformOwner) {
      throw new ForbiddenException({ messageKey: 'errors.forbidden' });
    }

    // ATO review F11 — the whole platform sits behind this guard, so from
    // the configured date a Platform Owner must have a confirmed
    // authenticator app to use it (an emailed code alone is not enough for
    // this role: it depends on one mailbox and one email provider). The
    // account can still sign in and reach its own security settings —
    // enrolment is not behind this guard — and recovery codes keep it
    // self-recoverable.
    const requiredFrom =
      this.configService.getOrThrow<IdentityConfig>(
        'identity',
      ).platformOwnerTotpRequiredFrom;
    if (requiredFrom && Date.now() >= requiredFrom.getTime()) {
      const twoFactor = await runInUserContext(this.prisma, userId, (tx) =>
        tx.userTwoFactor.findUnique({ where: { userId }, select: { confirmedAt: true } }),
      );
      if (!twoFactor?.confirmedAt) {
        throw new ForbiddenException({
          messageKey: 'errors.auth.platformOwnerTwoFactorRequired',
        });
      }
    }

    return true;
  }
}
