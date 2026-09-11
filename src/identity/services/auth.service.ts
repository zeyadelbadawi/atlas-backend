/**
 * AuthService — the full P1 authentication lifecycle (master plan §8,
 * §21 Phase P1). Controllers stay thin; every business rule lives here.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import type { IdentityConfig } from '../../config/configuration';
import { UsersRepository } from '../repositories/users.repository';
import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';
import { deriveDeviceLabel } from '../utils/request-metadata.util';
import { SessionRevocationService } from './session-revocation.service';
import {
  toUserSessionResponse,
  type UserSessionResponse,
} from '../dto/user-session.contract';
import { PasswordResetTokensRepository } from '../repositories/password-reset-tokens.repository';
import { PasswordHasherService } from './password-hasher.service';
import { AccessTokenService } from './access-token.service';
import { generateOpaqueToken, hashOpaqueToken } from '../utils/opaque-token.util';
import { normalizeEmail } from '../utils/email.util';
import { toCurrentUser } from '../dto/contracts';
import type {
  AuthenticationResponseContract,
  AuthenticationSessionContract,
  TokenRefreshResponseContract,
} from '../dto/contracts';
import { PasswordResetEmailProducer } from '../queue/password-reset-email.producer';
import { UserOrganizationsService } from '../../tenancy/services/user-organizations.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { EmailRiskService } from './email-risk.service';
import { TwoFactorService } from './two-factor.service';
import { EmailVerificationTokensRepository } from '../repositories/email-verification-tokens.repository';
import { EMAIL_PROVIDER } from './email-provider.interface';
import type { EmailProvider } from './email-provider.interface';
import { emailDomain } from '../../plans/utils/trial-subject.util';

/** A value nobody can ever sign in with — see `getDummyHash()`. */
const DUMMY_PASSWORD = 'atlas-p1-dummy-password-for-timing-safety-only';

/**
 * Real request metadata for the session being created or refreshed —
 * resolved server-side from headers by `request-metadata.util.ts`, never
 * taken from a request body. Optional throughout so non-HTTP callers
 * (tests, future background flows) can issue a session without inventing
 * an IP or user agent.
 */
export interface SessionRequestContext {
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * Lazily computed, cached Argon2id hash of a value nobody can sign in
   * with. Verified against on every "user not found" sign-in attempt so
   * the response time for "no such account" and "wrong password" stays
   * statistically similar — a standard defense against
   * account-enumeration-by-timing. Computed at runtime (not a hand-written
   * literal) so it's guaranteed to be a real, correctly-formatted Argon2id
   * hash that costs the same CPU time to verify as a genuine one.
   */
  private dummyHash: Promise<string> | undefined;

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.passwordHasher.hash(DUMMY_PASSWORD);
    return this.dummyHash;
  }

  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly refreshTokensRepository: RefreshTokensRepository,
    private readonly passwordResetTokensRepository: PasswordResetTokensRepository,
    private readonly passwordHasher: PasswordHasherService,
    private readonly accessTokenService: AccessTokenService,
    private readonly configService: ConfigService,
    private readonly passwordResetEmailProducer: PasswordResetEmailProducer,
    private readonly userOrganizationsService: UserOrganizationsService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly sessionRevocationService: SessionRevocationService,
    private readonly emailRiskService: EmailRiskService,
    private readonly emailVerificationTokensRepository: EmailVerificationTokensRepository,
    private readonly twoFactorService: TwoFactorService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
  ) {}

  /**
   * Resolves and validates a caller-supplied Academy context for
   * registration (Phase 1, Extended Scope, Decision 11, dependency D).
   * `academyId` is optional — a brand-new user completing the
   * self-service Organization-Owner onboarding journey (Decision 5)
   * registers with none, exactly as before this phase. When supplied (a
   * public Academy website's Sign Up page, dependency C), it must resolve
   * to a REAL, existing Academy — reusing the exact
   * `resolve_academy_organization` `SECURITY DEFINER` lookup the public
   * website runtime already relies on for the identical "no session
   * context yet" problem (see `AcademyStudentsRepository.
   * resolveOrganizationId`'s own doc comment) — never a second, invented
   * mechanism. An unresolvable id fails the whole registration rather
   * than silently falling back to an Organization-level or academy-less
   * account, matching this dependency's explicit requirement.
   */
  private async resolveRegistrationAcademyId(
    academyId: string | undefined,
  ): Promise<string | undefined> {
    if (!academyId) return undefined;

    const organizationId =
      await this.academyStudentsRepository.resolveOrganizationId(academyId);
    if (!organizationId) {
      throw new NotFoundException({ messageKey: 'errors.academy.notFound' });
    }

    const academy = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => tx.academy.findUnique({ where: { id: academyId } }),
    );
    if (!academy) {
      throw new NotFoundException({ messageKey: 'errors.academy.notFound' });
    }

    return academy.id;
  }

  /**
   * Creates an account. Deliberately does not establish a session — matches
   * `RegistrationRequest`'s frontend behavior of navigating to sign-in
   * afterward (master plan §8, §21 P1: "Do NOT auto-login after
   * registration").
   */
  async register(input: {
    name: string;
    email: string;
    password: string;
    academyId?: string;
  }): Promise<void> {
    const email = normalizeEmail(input.email);
    const existing = await this.usersRepository.findByEmail(email);
    if (existing) {
      // Registration duplicate-email disclosure is the one deliberate
      // exception to "never reveal account existence" in this service —
      // the caller must be told to sign in instead, and the frontend has
      // no other way to explain a failed registration. This is distinct
      // from password-reset-request below, where the requester is
      // unauthenticated and has not proven they should learn anything
      // about the account.
      throw new ConflictException({
        messageKey: 'errors.auth.emailAlreadyRegistered',
      });
    }

    // Phase 10.1 — disposable/undeliverable addresses are refused here,
    // on the server, for every caller. The frontend may also check, but
    // this is the enforcement point: calling the API directly must not
    // bypass it.
    //
    // The rejection is deliberately GENERIC. Reporting whether the domain
    // was on the throwaway list or simply had no mail exchanger would
    // tell an abuser precisely how to adapt, so both map to one message.
    const emailRisk = await this.emailRiskService.evaluate(email);
    if (!emailRisk.acceptable) {
      this.logger.log(
        { reason: emailRisk.reason, domain: emailDomain(email) },
        'Registration refused — address is not an acceptable, deliverable mailbox.',
      );
      throw new BadRequestException({
        messageKey: 'errors.auth.emailNotAcceptable',
      });
    }

    // Validated BEFORE the account is created — a bad/unknown academyId
    // must never leave an orphaned user record behind.
    const academyId = await this.resolveRegistrationAcademyId(input.academyId);

    const passwordHash = await this.passwordHasher.hash(input.password);
    const user = await this.usersRepository.create({
      email,
      passwordHash,
      name: input.name,
    });

    if (academyId) {
      // Self-insert, under the new user's own identity — see the
      // migration's `academy_students_self_insert` policy doc comment for
      // why this is the one write on this table that needs no tenant
      // context: this IS the step that gives the account its first real
      // Academy fact.
      await this.tenancyContextService.runInUserContext(user.id, (tx) =>
        this.academyStudentsRepository.create(tx, {
          academyId,
          userId: user.id,
        }),
      );
    }

    // Best-effort by design. The account exists and is usable; failing
    // the whole registration because an SMTP provider had a bad minute
    // would be a worse outcome than an unverified account the user can
    // re-trigger verification for at any time.
    await this.sendEmailVerification(user.id, email);
  }

  /**
   * Issues a fresh verification token and emails it.
   *
   * Any previously outstanding token for this user is invalidated first,
   * so only the most recent link ever works — a user who requests
   * verification twice cannot leave a second live token behind.
   */
  private async sendEmailVerification(userId: string, email: string): Promise<void> {
    try {
      const identity = this.configService.getOrThrow<IdentityConfig>('identity');
      const rawToken = generateOpaqueToken();

      await this.emailVerificationTokensRepository.invalidateAllForUser(userId);
      await this.emailVerificationTokensRepository.create({
        userId,
        tokenHash: hashOpaqueToken(rawToken),
        expiresAt: new Date(
          Date.now() + identity.emailVerificationTokenTtlMinutes * 60 * 1000,
        ),
      });

      await this.emailProvider.sendEmailVerification(email, rawToken);
    } catch (error) {
      // Logged WITHOUT the token — the raw value must never reach a log
      // sink, since it is a live credential until used or expired.
      this.logger.warn(
        { userId, error: error instanceof Error ? error.message : error },
        'Could not send the verification email; the account exists and verification can be re-requested.',
      );
    }
  }

  /**
   * Completes verification.
   *
   * Single-use and replay-proof: the token is claimed with a conditional
   * UPDATE that only matches a row which is unexpired and not yet used,
   * so a replayed link matches zero rows and is refused. Two concurrent
   * submissions of the same link resolve the same way — Postgres
   * serialises the update and only one can observe `usedAt` still null.
   *
   * Failures are deliberately indistinguishable: unknown, expired,
   * already-used and malformed tokens all produce the same error, so the
   * endpoint cannot be used to probe which tokens exist.
   */
  async verifyEmail(rawToken: string): Promise<void> {
    const claimed = await this.emailVerificationTokensRepository.claim(
      hashOpaqueToken(rawToken),
    );

    if (!claimed) {
      throw new BadRequestException({
        messageKey: 'errors.auth.invalidVerificationToken',
      });
    }

    await this.usersRepository.markEmailVerified(claimed.userId, new Date());
  }

  /**
   * Re-sends verification for the signed-in account.
   *
   * Always reports success, even when the account is already verified —
   * the caller is authenticated, so there is nothing to disclose, and a
   * uniform response keeps the client simple. Rate limiting lives on the
   * controller: this is an endpoint that sends mail on demand.
   */
  async resendEmailVerification(userId: string): Promise<void> {
    const user = await this.usersRepository.findById(userId);
    if (!user || user.emailVerifiedAt) return;
    await this.sendEmailVerification(user.id, user.email);
  }

  async signIn(input: {
    email: string;
    password: string;
    context?: SessionRequestContext;
  }): Promise<AuthenticationResponseContract> {
    const email = normalizeEmail(input.email);
    const user = await this.usersRepository.findByEmail(email);

    if (!user) {
      await this.passwordHasher.verify(await this.getDummyHash(), input.password);
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidCredentials' });
    }

    const passwordValid = await this.passwordHasher.verify(
      user.passwordHash,
      input.password,
    );
    if (!passwordValid) {
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidCredentials' });
    }

    // Phase 10.6 — a deleted account can never sign in again.
    //
    // Checked BEFORE suspension and reported as ordinary invalid
    // credentials rather than as a distinct "this account was deleted"
    // error: the address is anonymised at deletion, so confirming that a
    // deleted account once existed here would leak more than it helps.
    // The password hash is also replaced with a value no password can
    // produce, so this check is the second of two independent barriers,
    // not the only one.
    if (user.status === 'deleted') {
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidCredentials' });
    }

    // Suspension is only ever revealed to someone who already proved they
    // know the correct password — no enumeration signal added.
    if (user.status === 'suspended') {
      throw new ForbiddenException({ messageKey: 'errors.auth.accountSuspended' });
    }

    // =====================================================================
    // SECOND FACTOR (Phase 10.3 — implements what Phase 10 deferred)
    // =====================================================================
    // Positioned exactly where Phase 10's insertion point was, and for
    // the same reason: the password and the account status have both been
    // proven, but NOTHING has been issued yet. `issueSession` below is
    // what mints the access token, the refresh token and the session row.
    // Returning here means the caller holds no credential of any kind —
    // only a challenge reference that authenticates nothing.
    //
    // The challenge is completed by `POST /auth/2fa/verify`, which calls
    // `issueSessionForVerifiedUser` — so `issueSession` remains the one
    // and only place a session is minted, shared by both paths.
    if (await this.twoFactorService.isEnforcedFor(user.id)) {
      const challenge = await this.twoFactorService.createChallenge(user.id);
      return {
        twoFactorRequired: true,
        challengeId: challenge.challengeId,
        expiresIn: challenge.expiresIn,
      };
    }
    // =====================================================================

    const session = await this.issueSession(user, input.context);
    await this.usersRepository.touchLastSignInAt(user.id);

    return session;
  }

  /**
   * Phase 10.3 — completes a 2FA challenge and issues the real session.
   *
   * The user id comes from `TwoFactorService.completeChallenge`, which
   * resolved it from the server-side challenge record — never from
   * anything the caller supplied. This is the second and only other
   * caller of `issueSession`, so session minting stays in one place.
   */
  async completeTwoFactorSignIn(
    challengeId: string,
    input: { token?: string; recoveryCode?: string },
    context?: SessionRequestContext,
  ): Promise<AuthenticationSessionContract> {
    const userId = await this.twoFactorService.completeChallenge(challengeId, input);

    const user = await this.usersRepository.findById(userId);
    if (!user) {
      // The account vanished between password and second factor. Same
      // generic failure as a bad code — nothing is disclosed.
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidTwoFactorCode' });
    }

    const session = await this.issueSession(user, context);
    await this.usersRepository.touchLastSignInAt(user.id);
    return session;
  }

  /**
   * Atomically rotates a refresh token — see
   * `RefreshTokensRepository.rotate`'s doc comment for the concurrency
   * guarantee this relies on.
   */
  async refresh(
    rawRefreshToken: string,
    context?: SessionRequestContext,
  ): Promise<TokenRefreshResponseContract> {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const presentedHash = hashOpaqueToken(rawRefreshToken);

    const newRawToken = generateOpaqueToken();
    const newHash = hashOpaqueToken(newRawToken);
    const expiresAt = new Date(
      Date.now() + identity.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    );

    const result = await this.refreshTokensRepository.rotate(presentedHash, {
      tokenHash: newHash,
      expiresAt,
      // Phase 10 — re-read from the LIVE request so `lastUsedAt` reflects
      // real session activity and a moved/upgraded client updates its own
      // row. `rotate` falls back to the claimed row's values when a
      // client sends no User-Agent, so a refresh never blanks these out.
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      deviceLabel: deriveDeviceLabel(context?.userAgent),
    });

    if (!result) {
      // Covers: unknown token, already-revoked token (including a replay
      // of a token a concurrent request just rotated), and expired token —
      // all collapse to the same generic 401, never distinguishing which,
      // so a caller can't probe for which failure mode applies.
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidRefreshToken' });
    }

    // Phase 10 — `sid` is the SESSION id, never the refresh-token row id.
    // This previously carried `created.id`, which changes on every
    // rotation, and that was a genuine hole rather than a cosmetic one:
    // `JwtAuthGuard` looks the `sid` up on the revocation denylist, so an
    // access token minted by a refresh carried a `sid` no revocation could
    // ever match, and the session stayed usable for the token's full
    // lifetime after the user revoked it. Carrying the family id forward
    // is also what lets the session list mark the caller's own row
    // `isCurrent` after the token has rotated.
    const accessToken = this.accessTokenService.issue({
      sub: result.created.userId,
      sid: result.created.sessionId,
    });

    return {
      accessToken: accessToken.token,
      refreshToken: newRawToken,
      expiresIn: accessToken.expiresInSeconds,
    };
  }

  /**
   * Revokes exactly the session tied to `sessionId` (the access token's
   * `sid` claim) for `userId` — never every device. See
   * `AccessTokenService`'s doc comment for why `sid` is what makes this
   * possible given the frontend sends no refresh token on sign-out.
   * Idempotent: revoking an already-gone session is still a success.
   */
  /**
   * Phase 10 — the caller's own active sessions. `userId` always comes
   * from the verified access token at the controller, never from input,
   * and the repository query is scoped by it, so this cannot return
   * another user's rows.
   */
  async listSessions(
    userId: string,
    currentSessionId: string,
  ): Promise<readonly UserSessionResponse[]> {
    const rows = await this.refreshTokensRepository.findActiveSessionsForUser(userId);
    return rows.map((row) => toUserSessionResponse(row, currentSessionId));
  }

  /**
   * Phase 10 — revokes one of the caller's own sessions, immediately.
   *
   * Two steps, in this order and both required:
   *   1. Revoke every row in the rotation family, scoped by `userId`.
   *      This is durable and stops the session ever refreshing again.
   *   2. Add the session to the revocation denylist, which is what stops
   *      an ALREADY-ISSUED access token on the very next request. Without
   *      it, revocation would not take effect until the token expired,
   *      and the roadmap's acceptance criterion would be unmet.
   *
   * A session id that does not belong to this user revokes zero rows and
   * raises the same not-found as one that never existed, so the endpoint
   * cannot be used to probe whether another user's session id is real.
   */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const revoked = await this.refreshTokensRepository.revokeSessionForUser(
      sessionId,
      userId,
    );

    if (revoked === 0) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    await this.sessionRevocationService.markRevoked(sessionId);
  }

  async signOut(userId: string, sessionId: string): Promise<void> {
    // Phase 10 — `sid` is now the SESSION id, so revoke the whole
    // rotation family rather than a single row, and deny the access token
    // immediately. Before this, signing out left the current access token
    // usable for the rest of its lifetime.
    await this.refreshTokensRepository.revokeSessionForUser(sessionId, userId);
    await this.sessionRevocationService.markRevoked(sessionId);
  }

  /**
   * Backs `GET /auth/validate` (`authenticationService.validateSession`).
   * Reaching this method at all means the auth guard already verified the
   * access token — there's nothing further to check or return.
   */
  validateSession(): void {
    // Intentionally empty — see doc comment.
  }

  /**
   * Never reveals whether `email` belongs to an account — the response is
   * identical either way, and this method resolves before the caller can
   * observe whether the (Redis-queued) email step happened. Rate limiting
   * is applied by the controller/guard layer, not here.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const normalized = normalizeEmail(email);
    const user = await this.usersRepository.findByEmail(normalized);

    if (!user) {
      return; // No account — silently succeed, matching the frontend's own copy: "If an account exists with that email...".
    }

    const rawToken = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(rawToken);
    const expiresAt = new Date(
      Date.now() + identity.passwordResetTokenTtlMinutes * 60 * 1000,
    );

    await this.passwordResetTokensRepository.create({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    await this.passwordResetEmailProducer.enqueue({
      userId: user.id,
      email: user.email,
      rawToken,
      expiresAt: expiresAt.toISOString(),
    });
  }

  /**
   * Validates + consumes a reset token, rotates the password, and revokes
   * every existing refresh token for the account (master plan §8/§21 P1) —
   * unlike `signOut`, this is a deliberate all-sessions revocation, because
   * a password reset is exactly the scenario where every existing session
   * should be treated as no-longer-trusted.
   */
  async confirmPasswordReset(rawToken: string, newPassword: string): Promise<void> {
    const tokenHash = hashOpaqueToken(rawToken);
    const resetToken =
      await this.passwordResetTokensRepository.findValidByHash(tokenHash);

    if (!resetToken) {
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidResetToken' });
    }

    const passwordHash = await this.passwordHasher.hash(newPassword);

    await this.usersRepository.updatePasswordHash(resetToken.userId, passwordHash);
    await this.passwordResetTokensRepository.markUsed(resetToken.id);
    await this.refreshTokensRepository.revokeAllForUser(resetToken.userId);

    // Phase P15 retroactive audit coverage (master plan §8: "security
    // events... fold into audit_log_entries"). This flow predates any
    // shared `$transaction` across its three writes above (a P1
    // structural fact, not something this phase should restructure) —
    // `writeBestEffort`, in its own small transaction, is the documented,
    // lower-risk choice; see that method's own doc comment.
    await this.prisma.$transaction((tx) =>
      this.auditLogWriterService.writeBestEffort(tx, {
        actorUserId: resetToken.userId,
        action: 'password_reset.confirmed',
        targetType: 'user',
        targetId: resetToken.userId,
      }),
    );
  }

  /**
   * The ONE place a session is minted. Kept single deliberately: the
   * future second-factor verify path (see the 2FA insertion point in
   * `signIn`) must issue sessions through exactly this method rather than
   * duplicating token creation.
   */
  private async issueSession(
    user: User,
    context?: SessionRequestContext,
  ): Promise<AuthenticationSessionContract> {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const rawRefreshToken = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(rawRefreshToken);
    const expiresAt = new Date(
      Date.now() + identity.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    );

    // Phase 10 — a new device session begins here. Every later rotation
    // copies this id forward, so it identifies the DEVICE for the whole
    // life of the session rather than one link in the rotation chain.
    const sessionId = randomUUID();

    const refreshToken = await this.refreshTokensRepository.create({
      userId: user.id,
      tokenHash,
      expiresAt,
      sessionId,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
      deviceLabel: deriveDeviceLabel(context?.userAgent),
    });

    const accessToken = this.accessTokenService.issue({
      sub: user.id,
      // `sid` is the stable session id, not the row id. For sessions
      // created before Phase 10 the migration backfilled `session_id` to
      // the row's own id, so tokens issued under the old scheme keep
      // resolving to the same session.
      sid: refreshToken.sessionId,
    });

    const organizationMemberships =
      await this.userOrganizationsService.getMembershipsForUser(user.id);

    return {
      accessToken: accessToken.token,
      refreshToken: rawRefreshToken,
      expiresIn: accessToken.expiresInSeconds,
      user: toCurrentUser(user, organizationMemberships),
    };
  }
}
