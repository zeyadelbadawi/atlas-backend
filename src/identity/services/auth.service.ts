/**
 * AuthService — the full P1 authentication lifecycle (master plan §8,
 * §21 Phase P1). Controllers stay thin; every business rule lives here.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { SessionActivityService } from './session-activity.service';
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
import { emailDomain } from '../../plans/utils/trial-subject.util';
import { PrincipalResolverService } from '../../tenancy/services/principal-resolver.service';
import { SurfaceEnforcementService } from '../../tenancy/services/surface-enforcement.service';
import {
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  StudentDeviceService,
} from '../../tenancy/services/student-device.service';
import { AccessPolicyService } from '../../tenancy/services/access-policy.service';
import type { Principal } from '../../tenancy/services/principal-resolver.service';
import { AcademySurfaceService } from './academy-surface.service';
import { EmailOtpService } from './email-otp.service';
import { CommunicationMetricsService } from '../../communications/metrics/communication-metrics.service';
import { CommunicationService } from '../../communications/services/communication.service';
import type { EmitResult } from '../../communications/services/communication.service';
import { AcademyStaffRecipientsService } from '../../communications/services/academy-staff-recipients.service';
import { TrustedDeviceService } from './trusted-device.service';
import type { EmailOtpChallengeContract } from '../dto/contracts';
import type { SignInSurface } from '../dto/sign-in.dto';

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
  /**
   * ISO 3166-1 alpha-2, from Cloudflare's edge. Absent in local
   * development and wherever Cloudflare reported no usable country —
   * never substituted with a guess.
   */
  readonly locationCountry?: string;
  /** P64 Phase 1 — the request's `Host`, for academy-surface verification. */
  readonly hostname?: string;
  /**
   * P64 Phase 2 (AD-10) — the `atlas_device` cookie the browser presented,
   * if any. Read from the real request by the controller, never from the
   * body: a client must not be able to name its own device row.
   */
  readonly deviceCookie?: string;
  /**
   * Called when a NEW device was registered for this sign-in and its
   * cookie has to be written to the response.
   *
   * A callback rather than a new return type, following
   * `OrganizationsService.create`'s established `onCreated` precedent
   * (see `TenancyModule`'s header comment): setting a cookie is an HTTP
   * concern that belongs to the controller, and threading it through
   * `AuthenticationSessionContract` would put a server-only secret into
   * the wire contract every client already consumes.
   */
  readonly onDeviceCookie?: (value: string, maxAgeSeconds: number) => void;
  /**
   * P64 Communications C4 (§12) — the `atlas_trust` cookie the browser
   * presented, if any. Like `deviceCookie` it is read from the real
   * `Cookie` header by the controller and NEVER from the body: a client
   * must not be able to nominate itself as a trusted device.
   *
   * A DIFFERENT cookie from `atlas_device` on purpose — see
   * `TrustedDeviceService`'s own doc comment.
   */
  readonly trustCookie?: string;
  /**
   * Called when this browser has just been trusted and its cookie must be
   * written to the response. Same callback shape, and the same reason, as
   * `onDeviceCookie`: setting a cookie is an HTTP concern belonging to the
   * controller, and a server-only secret must not enter the wire contract.
   */
  readonly onTrustCookie?: (value: string, maxAgeSeconds: number) => void;
}

/** P64 Phase 1 (AD-5) — what a session is minted for. */
export interface SessionSurfaceSelection {
  readonly surface: SignInSurface;
  readonly academyId?: string;
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
    private readonly sessionActivityService: SessionActivityService,
    private readonly sessionRevocationService: SessionRevocationService,
    private readonly emailRiskService: EmailRiskService,
    private readonly emailVerificationTokensRepository: EmailVerificationTokensRepository,
    private readonly twoFactorService: TwoFactorService,
    private readonly principalResolver: PrincipalResolverService,
    private readonly surfaceEnforcement: SurfaceEnforcementService,
    private readonly academySurfaceService: AcademySurfaceService,
    private readonly studentDeviceService: StudentDeviceService,
    private readonly accessPolicyService: AccessPolicyService,
    private readonly emailOtpService: EmailOtpService,
    private readonly trustedDeviceService: TrustedDeviceService,
    private readonly communicationMetrics: CommunicationMetricsService,
    // P64 Communications C3 (plan §8 B1) — the new-device feed row. From
    // the `@Global()` `CommunicationsModule`, like the metrics above, so
    // `IdentityModule` needs no new import (`EmailOtpService` and
    // `UsersService` already inject this service the same way).
    private readonly communicationService: CommunicationService,
    private readonly staffRecipients: AcademyStaffRecipientsService,
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
    inviteToken?: string;
    hostname?: string;
  }): Promise<void> {
    const email = normalizeEmail(input.email);
    const existing = await this.usersRepository.findByEmail(email);
    if (existing) {
      // Registration duplicate-email disclosure is the one deliberate
      // exception to "never reveal account existence" in this service —
      // the caller must be told to sign in instead, and the frontend has
      // no other way to explain a failed registration.
      throw new ConflictException({
        messageKey: 'errors.auth.emailAlreadyRegistered',
      });
    }

    // Phase 10.1 — disposable/undeliverable addresses are refused here,
    // on the server, for every caller. The rejection is deliberately
    // generic (throwaway list vs. no mail exchanger both map to one key).
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

    // P64 Phase 1 — the surface decides what this registration may create.
    // A request arriving on a real academy host MUST carry that academy's
    // id (a learner is never created without an academy, and never for an
    // academy the host does not serve); a request on the management host
    // with no academy id is staff onboarding and creates no learner row.
    const hostAcademyId = await this.academySurfaceService.resolveHostAcademyId(
      input.hostname,
    );
    if (hostAcademyId && !input.academyId) {
      throw new BadRequestException({ messageKey: 'errors.auth.academyContextRequired' });
    }
    if (input.academyId) {
      await this.academySurfaceService.assertAcademyMatchesHost(
        input.academyId,
        input.hostname,
      );
    }

    // Validated BEFORE the account is created — a bad/unknown academyId
    // must never leave an orphaned user record behind.
    const academyId = await this.resolveRegistrationAcademyId(input.academyId);
    const admission = academyId
      ? await this.academySurfaceService.admissionForNewLearner(
          academyId,
          input.inviteToken,
          // `email` is already `normalizeEmail(input.email)` (top of this
          // method) — an invite bound to a specific address is redeemable
          // only by the identity being created for that same address.
          email,
        )
      : undefined;

    const passwordHash = await this.passwordHasher.hash(input.password);
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const rawVerificationToken = generateOpaqueToken();
    const userId = randomUUID();

    const pendingApprovalOutboxIds: (string | null)[] = [];

    // P64 Phase 1 (Finding F4) — ONE transaction: the user row, the
    // academy membership and the verification-token outbox entry either
    // all exist or none do. The membership insert runs under the new
    // user's own identity (`academy_students_self_insert`), so the user
    // id is minted here and the RLS context set on the same connection.
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      await tx.user.create({
        data: { id: userId, email, passwordHash, name: input.name },
      });
      if (academyId && admission) {
        const student = await this.academyStudentsRepository.create(tx, {
          academyId,
          userId,
          status: admission.status,
          source: admission.source,
          registeredViaHost: input.hostname ?? null,
        });

        // P64 C3 (plan §8 G1). A `pending` learner is BLOCKED until staff
        // act, so nobody being told is a person stuck indefinitely whose
        // only recourse is to complain. Emitted inside this transaction,
        // so a registration that rolls back leaves no phantom work item.
        //
        // The acting context is the brand-new user's own, which can see
        // neither the academy's members nor the academy row — hence the
        // definer-backed staff lookup, and hence no `academyName` here
        // (the dispatcher resolves branding itself).
        if (admission.status === 'pending') {
          const approvers = await this.staffRecipients.moderators(tx, academyId);
          for (const approverUserId of approvers) {
            const emitted = await this.communicationService.emit(tx, {
              key: 'roster.student.awaiting_approval',
              recipientUserId: approverUserId,
              academyId,
              entity: { type: 'academy_student', id: student.id },
              // The roster link is `/dashboard/academy/:academyId/members`,
              // so the academy travels in `values` — the rule context
              // only sees `{ entity, values }`.
              values: { academyId },
            });
            pendingApprovalOutboxIds.push(emitted.outboxId);
          }
        }
      }
      await tx.emailVerificationToken.create({
        data: {
          userId,
          tokenHash: hashOpaqueToken(rawVerificationToken),
          expiresAt: new Date(
            Date.now() + identity.emailVerificationTokenTtlMinutes * 60 * 1000,
          ),
        },
      });
    });

    for (const outboxId of pendingApprovalOutboxIds) {
      await this.communicationService.enqueueAfterCommit(outboxId);
    }

    // Delivery is best-effort AFTER commit: the account and its token
    // exist; a bad SMTP minute must not undo a registration, and the user
    // can re-request verification at any time.
    try {
      await this.emitEmailVerification(userId, rawVerificationToken);
    } catch (error) {
      this.logger.warn(
        { userId, error: error instanceof Error ? error.message : error },
        'Could not send the verification email; the account exists and verification can be re-requested.',
      );
    }
  }

  /**
   * Issues a fresh verification token and emails it.
   *
   * Any previously outstanding token for this user is invalidated first,
   * so only the most recent link ever works — a user who requests
   * verification twice cannot leave a second live token behind.
   */
  /**
   * Emits the verification event so the recipient gets a CTA button, not
   * a token.
   *
   * The legacy `EmailProvider.sendEmailVerification` pasted the raw token
   * into the body as `Verification token: <opaque>`, which is an internal
   * credential presented as if it were an instruction — a dead end for
   * the reader and English-only besides. `auth.email.verification` has
   * always existed in the catalogue with a bilingual template and an
   * `actionUrl`; it was simply never wired up. The token now travels
   * inside the link and is never displayed.
   */
  private async emitEmailVerification(userId: string, rawToken: string): Promise<void> {
    const outboxId = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const emitted = await this.communicationService.emit(tx, {
          key: 'auth.email.verification',
          recipientUserId: userId,
          entity: { type: 'email_verification', id: userId },
          // Consumed only by the catalogue's `actionUrl`, which puts it
          // in the href. No template prints it.
          values: { token: rawToken },
        });
        return emitted.outboxId;
      },
    );
    await this.communicationService.enqueueAfterCommit(outboxId);
  }

  private async sendEmailVerification(userId: string): Promise<void> {
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

      await this.emitEmailVerification(userId, rawToken);
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
    await this.sendEmailVerification(user.id);
  }

  async signIn(input: {
    email: string;
    password: string;
    surface?: SignInSurface;
    academyId?: string;
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
    // P64 Phase 1 (AD-5) — the surface is decided BEFORE any credential
    // is minted: a learner on the management surface is refused here with
    // the academies they can sign in through; an academy-surface sign-in
    // is bound to the academy the host serves and admitted under that
    // academy's registration policy. Runs before the second factor so a
    // refused surface never even starts a 2FA challenge.
    const selection = await this.resolveSurface(
      user,
      { surface: input.surface ?? 'management', academyId: input.academyId },
      input.context,
    );

    if (await this.twoFactorService.isEnforcedFor(user.id)) {
      const challenge = await this.twoFactorService.createChallenge(user.id);
      return {
        twoFactorRequired: true,
        challengeId: challenge.challengeId,
        expiresIn: challenge.expiresIn,
      };
    }

    // ---------------------------------------------------------------
    // EMAILED ONE-TIME CODE (P64 Communications C4 — the §12 model)
    // ---------------------------------------------------------------
    // Reached only when the account has NO confirmed TOTP. §12 is
    // explicit that the two are alternatives and never a stack: an
    // authenticator app is the stronger factor, so an account that has
    // one is never also asked to read an email. Placed after the surface
    // resolution for the same reason the 2FA branch is — a learner
    // refused on the management surface must not be mailed a code for a
    // sign-in that was never going to be allowed.
    //
    // Exactly like the 2FA branch, returning here means the caller holds
    // NOTHING: no access token, no refresh token, no session row — only
    // an opaque challenge reference that authenticates nothing and is
    // accepted by `/auth/otp/verify` and `/auth/otp/resend` alone.
    if (
      await this.emailOtpService.isRequired({
        userId: user.id,
        surface: selection.surface,
        trustCookie: input.context?.trustCookie,
      })
    ) {
      const challenge = await this.emailOtpService.issue({
        user,
        surface: selection.surface,
        academyId: selection.academyId,
        context: input.context,
      });
      return {
        emailOtpRequired: true,
        challengeId: challenge.challengeId,
        expiresAt: challenge.expiresAt.toISOString(),
        resendAvailableAt: challenge.resendAvailableAt.toISOString(),
        resendsRemaining: challenge.resendsRemaining,
        maskedEmail: challenge.maskedEmail,
      } satisfies EmailOtpChallengeContract;
    }
    // =====================================================================

    const session = await this.issueSession(user, input.context, selection);
    await this.usersRepository.touchLastSignInAt(user.id);

    return session;
  }

  /**
   * P64 Phase 1 — the surface rules, shared by password sign-in and the
   * 2FA completion path so both mint identical sessions.
   *
   * management: learners (student rows only, no staff fact) are refused
   *   with 403 `errors.auth.studentUseAcademySignIn` and the academies
   *   they belong to (name + public host) in `details.academies`.
   * academy: `academyId` is required and must match the request host.
   *   Staff of that academy and existing students sign in as they are; a
   *   blocked student is refused; anyone else is admitted under the
   *   academy's registration policy (open → joined now, `sign_in_join`;
   *   invite/approval → refused, the sign-up page handles those).
   */
  private async resolveSurface(
    user: User,
    requested: SessionSurfaceSelection,
    context?: SessionRequestContext,
  ): Promise<SessionSurfaceSelection> {
    const principal = await this.principalResolver.resolve(user.id);

    if (requested.surface === 'management') {
      // The refusal itself is staged by `surface.enforce` (master plan
      // Phase 1 §T). While the rollout has not reached this learner the
      // pre-P64 behaviour stands and a management session is issued — a
      // session that grants nothing RLS or any other guard would refuse,
      // because the surface is the only thing this flag governs.
      if (
        principal.kind === 'learner' &&
        this.surfaceEnforcement.isEnforcedFor(principal)
      ) {
        throw new ForbiddenException({
          messageKey: 'errors.auth.studentUseAcademySignIn',
          details: {
            academies: principal.academies.map((academy) => ({
              academyId: academy.academyId,
              name: academy.name,
              slug: academy.slug,
              host: academy.host ?? '',
            })),
          },
        });
      }
      return { surface: 'management' };
    }

    const academyId = requested.academyId;
    if (!academyId) {
      throw new BadRequestException({ messageKey: 'errors.auth.academyContextRequired' });
    }
    await this.academySurfaceService.assertAcademyMatchesHost(
      academyId,
      context?.hostname,
    );

    const membership = principal.academies.find(
      (academy) => academy.academyId === academyId,
    );
    if (membership?.blocked) {
      throw new ForbiddenException({ messageKey: 'errors.auth.academyAccessBlocked' });
    }
    if (membership) {
      return { surface: 'academy', academyId };
    }

    if (this.isStaffOfAcademy(principal, academyId) || principal.isPlatformOwner) {
      // Staff preview the academy site as a learner would; no student row
      // is invented for them.
      return { surface: 'academy', academyId };
    }

    const policy = await this.academySurfaceService.registrationPolicy(academyId);
    if (policy !== 'open') {
      throw new ForbiddenException({ messageKey: 'errors.auth.notAMemberOfAcademy' });
    }
    await this.tenancyContextService.runInUserContext(user.id, (tx) =>
      this.academyStudentsRepository.create(tx, {
        academyId,
        userId: user.id,
        status: 'active',
        source: 'sign_in_join',
        registeredViaHost: context?.hostname ?? null,
      }),
    );
    return { surface: 'academy', academyId };
  }

  private isStaffOfAcademy(principal: Principal, academyId: string): boolean {
    return principal.academyStaff.some((row) => row.academyId === academyId);
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
    requested: SessionSurfaceSelection = { surface: 'management' },
  ): Promise<AuthenticationSessionContract> {
    const userId = await this.twoFactorService.completeChallenge(challengeId, input);

    const user = await this.usersRepository.findById(userId);
    if (!user) {
      // The account vanished between password and second factor. Same
      // generic failure as a bad code — nothing is disclosed.
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidTwoFactorCode' });
    }

    // P64 Phase 1 — the surface is re-resolved here (the challenge holds
    // only the user id), so a learner can no more finish a management
    // sign-in through 2FA than start one.
    const selection = await this.resolveSurface(user, requested, context);
    const session = await this.issueSession(user, context, selection);
    await this.usersRepository.touchLastSignInAt(user.id);
    return session;
  }

  /**
   * P64 Communications C4 — completes a sign-in that stopped for an
   * emailed code, and issues the real session.
   *
   * Mirrors `completeTwoFactorSignIn` deliberately, including the part
   * that matters most: the user id comes from `EmailOtpService.verify`,
   * which resolved it from the sealed challenge reference and the
   * server-side row — never from anything the caller supplied. This is
   * the third and last caller of `issueSession`, so session minting
   * stays in one place.
   *
   * THE SURFACE COMES FROM THE CHALLENGE, NOT THE BODY. The frontend does
   * send `surface`/`academyId` (its `EmailOtpVerifyInput` carries them),
   * but the challenge row already records what the original sign-in was
   * for, and that is what is used. A body value could otherwise ask for a
   * session shaped for a surface the password step never approved. The
   * surface is then re-resolved through `resolveSurface` exactly as the
   * 2FA path does, so a learner can no more finish a management sign-in
   * through a code than start one.
   */
  async completeEmailOtpSignIn(
    challengeId: string,
    code: string,
    rememberDevice: boolean,
    context?: SessionRequestContext,
  ): Promise<AuthenticationSessionContract> {
    const verified = await this.emailOtpService.verify(challengeId, code, {
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    });

    const user = await this.usersRepository.findById(verified.userId);
    if (!user) {
      // The account vanished between the password and the code. Same
      // "this challenge is dead" answer as any other failure — nothing
      // about the account is disclosed.
      throw new UnauthorizedException({
        messageKey: 'errors.auth.otpAttemptsExceeded',
      });
    }

    const selection = await this.resolveSurface(
      user,
      { surface: verified.surface, academyId: verified.academyId },
      context,
    );
    const session = await this.issueSession(user, context, selection);
    await this.usersRepository.touchLastSignInAt(user.id);

    // §12: "Success also sets `users.emailVerifiedAt` if null." Reading a
    // code out of the inbox IS proof of ownership of the address — the
    // same proof the verification link asks for — so a separate
    // verification chore afterwards would be asking twice for one fact.
    if (!user.emailVerifiedAt) {
      try {
        await this.usersRepository.markEmailVerified(user.id, new Date());
      } catch (error) {
        this.logger.warn(
          {
            userId: user.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Could not record email verification after an OTP sign-in (ignored).',
        );
      }
    }

    if (rememberDevice) {
      await this.rememberDevice(user.id, selection.surface, context);
    }

    return session;
  }

  /**
   * Writes the trusted-device row and hands its cookie to the controller.
   *
   * Never throws. "Remember this device" is a convenience on top of an
   * already-successful sign-in; failing the whole request because the
   * trust row could not be written would turn a nicety into an outage,
   * and the only consequence of losing it is that the next sign-in asks
   * for another code — the safe direction.
   */
  private async rememberDevice(
    userId: string,
    surface: SignInSurface,
    context?: SessionRequestContext,
  ): Promise<void> {
    try {
      const minted = await this.trustedDeviceService.trust({
        userId,
        surface,
        userAgent: context?.userAgent,
        previousCookieValue: context?.trustCookie,
      });
      // The audit entry is written inside `trust`'s own transaction, with
      // the row it describes. Only the cookie and the metric are left,
      // because only they are HTTP/observability concerns.
      context?.onTrustCookie?.(minted.cookieValue, minted.maxAgeSeconds);
      this.communicationMetrics.recordTrustedDevice('trusted');
    } catch (error) {
      this.logger.warn(
        { userId, error: error instanceof Error ? error.message : String(error) },
        'Could not remember this device; the session itself was issued normally.',
      );
    }
  }

  /** P64 Phase 1 — non-consuming check used by the reset page; the token stays usable. */
  async isPasswordResetTokenValid(rawToken: string): Promise<boolean> {
    if (!rawToken) return false;
    const row = await this.passwordResetTokensRepository.findValidByHash(
      hashOpaqueToken(rawToken),
    );
    return row !== null;
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
      locationCountry: context?.locationCountry,
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

    // Phase 11.10 — Redis holds activity from ordinary authenticated
    // requests, which is fresher than the column (that is only flushed
    // every few minutes, by design). Take whichever is later: Redis when
    // it has a value, the persisted column otherwise, so a Redis flush or
    // restart degrades to a slightly older timestamp instead of losing
    // activity altogether.
    const recent = await this.sessionActivityService.getRecentActivity(
      rows.map((row) => row.sessionId),
    );

    return rows.map((row) => {
      const fromRedis = recent.get(row.sessionId);
      const stored = row.lastUsedAt;
      const freshest = fromRedis && (!stored || fromRedis > stored) ? fromRedis : stored;
      return toUserSessionResponse({ ...row, lastUsedAt: freshest }, currentSessionId);
    });
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
    // P64 Communications C4 (§12) — a reset is exactly the "this account
    // may be compromised" moment, so every browser that could skip the
    // emailed code loses that privilege too. Revoking sessions while
    // leaving trusted devices standing would keep an attacker's browser
    // one step ahead of the owner's.
    const forgotten = await this.trustedDeviceService.revokeAllForUser(
      resetToken.userId,
      'password_reset',
    );
    if (forgotten > 0) this.communicationMetrics.recordTrustedDevice('revoked_all');

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

    /*
      Tell the account owner their password was just reset.

      `auth.password.reset_confirmed` had a catalogue entry, a bilingual
      template and frontend copy, and NO producer — so completing a reset
      notified nobody. That is the gap that matters most in this flow:
      someone who obtains a reset link changes the password and the real
      owner hears nothing, while every session and trusted device has
      just been revoked out from under them. The sibling
      `auth.password.changed` (a signed-in user changing their own
      password) has always been emitted; this path was simply missed.

      Its own small transaction, for the reason the audit write above
      records: this flow predates any shared transaction across its
      writes, and restructuring that is not this change's job.
    */
    const emitted: EmitResult = await this.tenancyContextService.runInUserContext(
      resetToken.userId,
      (tx) =>
        this.communicationService.emit(tx, {
          key: 'auth.password.reset_confirmed',
          recipientUserId: resetToken.userId,
          entity: { type: 'user', id: resetToken.userId },
        }),
    );
    await this.communicationService.enqueueAfterCommit(emitted.outboxId);
  }

  /**
   * The ONE place a session is minted. Kept single deliberately: the
   * future second-factor verify path (see the 2FA insertion point in
   * `signIn`) must issue sessions through exactly this method rather than
   * duplicating token creation.
   */
  /**
   * Resolves (or registers) the device this sign-in is coming from.
   *
   * Runs in the learner's OWN user context so `student_devices_self_all`
   * is the policy in force — the guard's decision and RLS independently
   * agree that a person only ever touches their own device rows.
   *
   * Never throws. A device registry that could fail a sign-in would turn
   * a policy feature into an availability risk for the whole academy
   * surface; the worst case here is a session with no device, which the
   * grant endpoint then refuses with a message the learner can act on.
   */
  private async resolveSignInDevice(
    userId: string,
    academyId: string,
    context?: SessionRequestContext,
  ): Promise<string | null> {
    // P64 Communications C3 (plan §8 B1). Declared out here so the hint
    // can be sent once the transaction has committed.
    let outboxId: string | null = null;
    try {
      const deviceId = await this.tenancyContextService.runInUserContext(
        userId,
        async (tx) => {
          const policy = await this.accessPolicyService.resolveForAcademy(tx, academyId);
          const resolution = await this.studentDeviceService.resolveForSession(tx, {
            userId,
            academyId,
            cookieValue: context?.deviceCookie,
            userAgent: context?.userAgent,
            maxDevices: policy.maxDevices,
          });
          if (resolution.issueCookieValue && context?.onDeviceCookie) {
            context.onDeviceCookie(
              resolution.issueCookieValue,
              DEVICE_COOKIE_MAX_AGE_SECONDS,
            );
          }

          // P64 Communications C3 (plan §8 B1, §10 "B1/B2 device
          // registered/removed"). `issueCookieValue` is set on exactly
          // one path — the INSERT — so this fires for a genuinely new
          // browser and not for the cap refusal or a recognised device
          // being touched. In-app only by the catalogue: the learner is
          // sitting at the browser that was just registered, and §10's
          // own note for this row is "low volume".
          if (resolution.issueCookieValue && resolution.device) {
            // No academy NAME is read: this runs in the learner's own
            // user context, where `academies` is invisible (there is no
            // `academies_student_select` policy — an `academy_students`
            // row is not an `academy_members` row). The brand name the
            // person sees comes from `CommunicationBrandingService`,
            // which resolves it with full visibility at dispatch.
            const emitted = await this.communicationService.emit(tx, {
              key: 'device.registered',
              recipientUserId: userId,
              academyId,
              entity: { type: 'student_device', id: resolution.device.id },
              values: { deviceLabel: resolution.device.label },
            });
            outboxId = emitted.outboxId;
          }

          return resolution.device?.id ?? null;
        },
      );
      await this.communicationService.enqueueAfterCommit(outboxId);
      return deviceId;
    } catch (error) {
      this.logger.warn(
        {
          userId,
          academyId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Device registration failed during sign-in; issuing a session with no device.',
      );
      return null;
    }
  }

  private async issueSession(
    user: User,
    context?: SessionRequestContext,
    selection: SessionSurfaceSelection = { surface: 'management' },
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

    // P64 Phase 2 (AD-10) — bind this session to a registered DEVICE, but
    // only on the academy surface. Management sessions are staff sessions;
    // the device policy governs learning, and attaching a device row to a
    // staff session would both misreport the learner's device list and
    // consume a slot nobody asked for.
    //
    // Reaching the cap does NOT refuse the sign-in (see
    // `StudentDeviceService`'s own comment): the session is issued with no
    // device, and it is CONTENT delivery that is refused, which leaves the
    // learner able to reach the Devices page and remove one.
    const deviceId =
      selection.surface === 'academy' && selection.academyId
        ? await this.resolveSignInDevice(user.id, selection.academyId, context)
        : null;

    const refreshToken = await this.refreshTokensRepository.create({
      userId: user.id,
      tokenHash,
      expiresAt,
      sessionId,
      ipAddress: context?.ipAddress,
      locationCountry: context?.locationCountry,
      userAgent: context?.userAgent,
      deviceLabel: deriveDeviceLabel(context?.userAgent),
      surface: selection.surface,
      academyId: selection.academyId ?? null,
      deviceId,
    });

    const accessToken = this.accessTokenService.issue({
      sub: user.id,
      // `sid` is the stable session id, not the row id. For sessions
      // created before Phase 10 the migration backfilled `session_id` to
      // the row's own id, so tokens issued under the old scheme keep
      // resolving to the same session.
      sid: refreshToken.sessionId,
    });

    const [organizationMemberships, principal] = await Promise.all([
      this.userOrganizationsService.getMembershipsForUser(user.id),
      this.principalResolver.resolve(user.id),
    ]);

    return {
      accessToken: accessToken.token,
      refreshToken: rawRefreshToken,
      expiresIn: accessToken.expiresInSeconds,
      user: toCurrentUser(user, organizationMemberships, {
        ...principal,
        managementSurfaceEnforced: this.surfaceEnforcement.isEnforcedFor(principal),
      }),
    };
  }
}
