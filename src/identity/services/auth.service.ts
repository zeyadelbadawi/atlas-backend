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
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AuthMethod, User } from '@prisma/client';
import type { EmailOtpPolicy, IdentityConfig } from '../../config/configuration';
import { UsersRepository } from '../repositories/users.repository';
import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';
import {
  createPhoneForNewAccount,
  requireNormalizedPhone,
} from '../phone/user-phone.service';
import { deriveDeviceLabel } from '../utils/request-metadata.util';
import { SessionActivityService } from './session-activity.service';
import { SessionRevocationService } from './session-revocation.service';
import {
  toUserSessionResponse,
  type UserSessionResponse,
} from '../dto/user-session.contract';
import { PasswordResetTokensRepository } from '../repositories/password-reset-tokens.repository';
import { PasswordCredentialsService } from './password-credentials.service';
import { SignInThrottleService } from './sign-in-throttle.service';
import { AccessTokenService } from './access-token.service';
import { SIGNUP_ORGANIZATION_PORT } from './signup-organization.port';
import type {
  PreparedSignupOrganization,
  SignupOrganizationPort,
  SignupOrganizationResult,
} from './signup-organization.port';
import { recordSignup } from '../../observability/metrics/onboarding-metrics';
import { recordAcademyJoin } from '../../observability/metrics/member-metrics';
import type { SignupMetricMode } from '../../observability/metrics/onboarding-metrics';
import { generateOpaqueToken, hashOpaqueToken } from '../utils/opaque-token.util';
import { normalizeEmail } from '../utils/email.util';
import { scopeCurrentUserToSession, toCurrentUser } from '../dto/contracts';
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
import {
  isNameConflict,
  isOrganizationNameTaken,
  nameInvalid,
  organizationNameUnavailable,
  sqlNameKey,
} from '../../common/name-uniqueness/name-uniqueness';
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
import { recoveryAcademyId } from '../utils/recovery-surface.util';
import { AcademySurfaceService } from './academy-surface.service';
import { EmailOtpService } from './email-otp.service';
import { CommunicationMetricsService } from '../../communications/metrics/communication-metrics.service';
import { CommunicationService } from '../../communications/services/communication.service';
import type { EmitResult } from '../../communications/services/communication.service';
import { AcademyStaffRecipientsService } from '../../communications/services/academy-staff-recipients.service';
import { SupersededRefreshTokenException } from '../errors/superseded-refresh-token.exception';
import { UnprovenAccountService } from './unproven-account.service';
import { TrustedDeviceService } from './trusted-device.service';
import type { EmailOtpChallengeContract } from '../dto/contracts';
import type { SignInSurface } from '../dto/sign-in.dto';
import { recordSessionsRevoked } from '../../observability/metrics/auth-security-metrics';

/**
 * Real request metadata for the session being created or refreshed —
 * resolved server-side from headers by `request-metadata.util.ts`, never
 * taken from a request body. Optional throughout so non-HTTP callers
 * (tests, future background flows) can issue a session without inventing
 * an IP or user agent.
 */
/** Launch Stabilization A4 — whether registration created an account or added an academy to an existing one. */

/**
 * The shape an emailed verification token can have: base64url, within the
 * length range any token this service ever issued falls in (today's are
 * 43 characters; older test fixtures and legacy rows are longer). Anything
 * else is refused as `invalid` without a lookup.
 */
const VERIFICATION_TOKEN_FORMAT = /^[A-Za-z0-9_-]{16,512}$/;

/** `POST /auth/verify-email` refusals. `expired`/`used` only ever reach the holder of a real link. */
const VERIFICATION_FAILURE_MESSAGE_KEYS = {
  invalid: 'errors.auth.invalidVerificationToken',
  expired: 'errors.auth.verificationTokenExpired',
  used: 'errors.auth.verificationTokenUsed',
  signInRequired: 'errors.auth.verificationSignInRequired',
} as const;

/**
 * How long after a rotation a retired refresh token may be presented again
 * without being treated as stolen: two tabs refreshing the same token race
 * within milliseconds; a copied token is replayed minutes or days later.
 */
export const REFRESH_REUSE_GRACE_MS = 60_000;

export interface RegistrationResult {
  readonly account: 'new' | 'existing';
  /**
   * Set when an existing account joined an academy (A4): whether its new
   * learner membership is already active or awaits the academy's approval.
   */
  readonly status?: 'active' | 'pending';
}

/**
 * `GET /auth/academy-join/summary` — the account's OTHER academies, named
 * only to a fully signed-in session on the academy it just joined.
 */
export interface AcademyJoinSummary {
  readonly otherAcademies: readonly string[];
}

/**
 * How long after an existing account joined an academy its academy-website
 * session may ask which other academies the account already belongs to.
 * The question only makes sense as part of that join; afterwards the
 * academy session is told about its own academy only (A5).
 */
const JOIN_SUMMARY_WINDOW_MS = 30 * 60 * 1000;

/** `POST /auth/academy-join` — returned only after the password is proven. */
export interface AcademyJoinResult {
  readonly account: 'existing';
  readonly status: 'active' | 'pending';
  readonly name: string;
}

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

  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly refreshTokensRepository: RefreshTokensRepository,
    private readonly passwordResetTokensRepository: PasswordResetTokensRepository,
    private readonly passwordCredentials: PasswordCredentialsService,
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
    private readonly unprovenAccountService: UnprovenAccountService,
    private readonly communicationMetrics: CommunicationMetricsService,
    // P64 Communications C3 (plan §8 B1) — the new-device feed row. From
    // the `@Global()` `CommunicationsModule`, like the metrics above, so
    // `IdentityModule` needs no new import (`EmailOtpService` and
    // `UsersService` already inject this service the same way).
    private readonly communicationService: CommunicationService,
    private readonly staffRecipients: AcademyStaffRecipientsService,
    // Launch Stabilization A4 — the sign-in budgets, shared by the
    // existing-account academy signup so registration can never be a
    // second, unmetered password-guessing endpoint; and (ATO F7) where
    // every failed password is counted toward the address's ceiling.
    private readonly signInThrottle: SignInThrottleService,
    // New Customer Onboarding — provided by the global `OnboardingModule`;
    // absent in a module graph without it, which leaves the organization
    // signup unavailable (the safe direction). See the port's doc comment.
    @Optional()
    @Inject(SIGNUP_ORGANIZATION_PORT)
    private readonly signupOrganizationPort?: SignupOrganizationPort,
  ) {}

  /**
   * W4 — classifies a registration P2002 that may have been a name conflict,
   * by asking the boolean definer checks (the transaction has rolled back, so
   * the new account no longer exists and nothing is excluded). `null` when it
   * was not a name — the email/identity handling then decides.
   *
   * Organization names only. A LEARNER name is never answered to an
   * unauthenticated registration (security review, finding 2): the new
   * learner's admission is automatic and cannot fail on a name (see
   * `registerInternal`), so classifying one here would only re-open the
   * "does a person of this name study at this academy?" oracle.
   */
  private async classifyRegistrationNameConflict(input: {
    readonly organizationName?: string;
  }): Promise<ConflictException | null> {
    if (input.organizationName) {
      const key = await sqlNameKey(this.prisma, input.organizationName);
      if (key && (await isOrganizationNameTaken(this.prisma, key))) {
        return organizationNameUnavailable('organizationName');
      }
    }
    return null;
  }

  /**
   * Whether a registration's P2002 came from `users.email` — the only unique
   * index a duplicate registration can hit besides a federated identity's.
   * PostgreSQL names the index only when the caller may see the conflicting
   * row; under the identity tables' RLS (authentication audit, Decision 2)
   * it does not, so an unnamed conflict is settled by asking whether the
   * address now has an account. Anything else is a real defect and must not
   * be disguised as "email already registered".
   */
  private async isEmailConflict(
    error: Prisma.PrismaClientKnownRequestError,
    email: string,
  ): Promise<boolean> {
    const fields = uniqueTargetFields(error);
    if (fields.length > 0) return fields.some((field) => field.includes('email'));
    return (await this.usersRepository.findByEmail(email)) !== null;
  }

  /**
   * New Customer Onboarding — the organization signup's preconditions,
   * all checked before any write (docs/NEW_CUSTOMER_ONBOARDING.md §3.2).
   * The browser's plan choice is only a lookup key; the port re-reads the
   * live catalog and trial policy.
   */
  private async prepareSignupOrganization(
    input: { organizationName?: string; planId?: string; academyId?: string },
    hostAcademyId: string | null | undefined,
  ): Promise<PreparedSignupOrganization> {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    if (identity.signupOrganizationMode !== 'on' || !this.signupOrganizationPort) {
      throw new BadRequestException({
        messageKey: 'errors.auth.organizationSignupDisabled',
      });
    }
    // Learner registration on an academy host never creates an organization
    // (the Master Plan's registration-integrity rule).
    if (input.academyId || hostAcademyId) {
      throw new BadRequestException({ messageKey: 'errors.auth.signupFieldsNotAllowed' });
    }
    const organizationName = input.organizationName?.trim();
    if (!organizationName) {
      throw new BadRequestException({
        messageKey: 'errors.auth.organizationNameRequired',
      });
    }
    // W4 — organization names are unique platform-wide. Checked here, before
    // any write, and again under a lock inside the signup transaction
    // (`OrganizationsService.createInTransaction`). One generic answer — it
    // never says who holds the name — and only at submit: there is no public
    // availability endpoint. Reached for an already-registered address too,
    // so the decoy path does not become a second oracle.
    const organizationNameKey = await sqlNameKey(this.prisma, organizationName);
    if (organizationNameKey === '') throw nameInvalid('organizationName');
    if (await isOrganizationNameTaken(this.prisma, organizationNameKey)) {
      throw organizationNameUnavailable('organizationName');
    }
    try {
      return await this.signupOrganizationPort.prepare({
        organizationName,
        planId: input.planId,
      });
    } catch (error) {
      if (error instanceof BadRequestException) {
        const key = (error.getResponse() as { messageKey?: string }).messageKey;
        recordSignup(
          'organization',
          key === 'errors.auth.signupTrialsUnavailable'
            ? 'rejected_policy'
            : 'rejected_plan',
        );
      }
      throw error;
    }
  }

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
    /** New Customer Onboarding — docs/NEW_CUSTOMER_ONBOARDING.md §3.2. */
    organizationName?: string;
    planId?: string;
    /**
     * Phone number as typed + chosen country (docs/USER_PHONE.md). Optional:
     * an older sign-up page sends neither. Stored only for a brand-new
     * account; never applied to an existing one from a sign-up form.
     */
    phoneNumber?: string;
    phoneCountry?: string;
    /** Forensic only (recorded on a trial redemption), never a decision input. */
    context?: { readonly ipAddress?: string; readonly userAgent?: string };
  }): Promise<RegistrationResult> {
    const wantsOrganization =
      input.organizationName !== undefined || input.planId !== undefined;
    const metricMode: SignupMetricMode = wantsOrganization ? 'organization' : 'account';
    try {
      return await this.registerInternal(input, wantsOrganization, metricMode);
    } catch (error) {
      if (error instanceof ConflictException) recordSignup(metricMode, 'conflict');
      throw error;
    }
  }

  /**
   * Google Identity — creates ONE global account whose first sign-in method
   * is an external identity, in the same single transaction a password
   * registration uses (user + identity + learner row / organization bundle,
   * all or nothing). There is no usable password (`nopassword:` sentinel,
   * which no password verifies — a password is only ever set later through
   * the emailed reset flow). The address counts as verified only when the
   * provider is authoritative for it; otherwise the first emailed sign-in
   * code proves it, exactly as for a password signup. An address that
   * already has an account is a 409: an external identity never joins or
   * links an existing account from here.
   */
  async registerWithExternalIdentity(input: {
    readonly name: string;
    readonly email: string;
    readonly academyId?: string;
    readonly inviteToken?: string;
    readonly hostname?: string;
    readonly organizationName?: string;
    readonly planId?: string;
    readonly context?: { readonly ipAddress?: string; readonly userAgent?: string };
    readonly external: {
      readonly provider: 'google';
      readonly subject: string;
      readonly emailVerified: boolean;
    };
  }): Promise<User> {
    const wantsOrganization =
      input.organizationName !== undefined || input.planId !== undefined;
    const metricMode: SignupMetricMode = wantsOrganization ? 'organization' : 'account';
    try {
      await this.registerInternal(
        { ...input, password: '' },
        wantsOrganization,
        metricMode,
        input.external,
      );
    } catch (error) {
      if (error instanceof ConflictException) recordSignup(metricMode, 'conflict');
      throw error;
    }
    const user = await this.usersRepository.findByEmail(input.email);
    if (!user)
      throw new ConflictException({ messageKey: 'errors.auth.emailAlreadyRegistered' });
    return user;
  }

  /**
   * Google Identity — an already-proven existing account (its linked Google
   * identity) signs UP at an academy: the same membership write as the
   * password-proven join (`admitExistingAccount`: host check, blocked /
   * already-learner refusal, registration policy, audit, owner notice).
   * Already a learner here is not an error for this caller — the sign-in
   * simply continues.
   */
  async joinAcademyAsExistingAccount(
    user: User,
    input: { academyId: string; hostname?: string; inviteToken?: string },
  ): Promise<'active' | 'pending' | 'already'> {
    try {
      return await this.admitExistingAccount(user, user.email, input);
    } catch (error) {
      if (
        error instanceof ConflictException &&
        (error.getResponse() as { messageKey?: string }).messageKey ===
          'errors.auth.alreadyLearnerHere'
      ) {
        return 'already';
      }
      throw error;
    }
  }

  private async registerInternal(
    input: Parameters<AuthService['register']>[0],
    wantsOrganization: boolean,
    metricMode: SignupMetricMode,
    external?: {
      readonly provider: 'google';
      readonly subject: string;
      readonly emailVerified: boolean;
    },
  ): Promise<RegistrationResult> {
    const email = normalizeEmail(input.email);
    // Phone number — re-normalised here, never taken from the client as-is
    // (the DTO has already validated it). Checked before anything is read,
    // so a bad number is answered identically for every address.
    const phone =
      input.phoneNumber !== undefined || input.phoneCountry !== undefined
        ? requireNormalizedPhone(input.phoneNumber, input.phoneCountry)
        : undefined;
    // W4 — a name made only of marks, invisibles or spaces has nothing to
    // compare and is refused before anything else (for every address alike).
    if ((await sqlNameKey(this.prisma, input.name)) === '') throw nameInvalid('name');
    const existing = await this.usersRepository.findByEmail(email);
    if (existing && external) {
      throw new ConflictException({ messageKey: 'errors.auth.emailAlreadyRegistered' });
    }
    const academySignup = !external && !!input.academyId && !wantsOrganization;
    // An academy signup can prove an existing account (its own password),
    // so it is metered like a sign-in — for EVERY address, existing or not,
    // so the budget itself says nothing about which addresses exist.
    if (academySignup) {
      await this.signInThrottle.enforce({ email, ipAddress: input.context?.ipAddress });
    }
    // Launch Stabilization A4 — one global identity may be a learner at many
    // academies. An academy signup with an email that already has an Atlas
    // account ADDS this academy to that account once the account's own
    // password is proven; it never creates a second user.
    if (existing && academySignup) {
      const joined = await this.joinAcademyWithExistingAccount(existing, email, input);
      if (joined) return joined;
    } else if (academySignup) {
      // ATO review F6 — an existing address's academy signup verifies its
      // password (one Argon2 operation) before the decoy hash below; a new
      // address must cost the same, or the response time tells the two
      // apart. The same dummy verification an unknown sign-in performs.
      await this.passwordCredentials.verifyForUnknownAccount(
        input.password || randomUUID(),
      );
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

    // New Customer Onboarding — every organization/plan rule is checked
    // BEFORE anything is written, so a refused signup creates nothing.
    const preparedOrganization = wantsOrganization
      ? await this.prepareSignupOrganization(input, hostAcademyId)
      : undefined;

    // Validated BEFORE the account is created — a bad/unknown academyId
    // must never leave an orphaned user record behind.
    const academyId = await this.resolveRegistrationAcademyId(input.academyId);

    // Authentication audit (Decision 3) — an address that already has an
    // account and did not prove it: NOTHING is created, and the answer is
    // exactly the one a new address gets — every rule above has already run
    // identically, the registration policy is applied without spending an
    // invitation, and a password is hashed as a new account's would be. The
    // real owner is told by email how to continue (sign in, Google, reset).
    if (existing) {
      if (academyId) {
        await this.academySurfaceService.previewAdmissionForNewLearner(
          academyId,
          input.inviteToken,
          email,
        );
        // W4 / security review finding 2 — no learner-name check here: a
        // brand-new address is never refused for its name either (below).
      }
      await this.passwordCredentials.hashDecoy(input.password || randomUUID());
      await this.noticeSignupAttempt(existing, academyId ?? undefined);
      return { account: 'new' };
    }

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
    // W4 / security review finding 2 — NO learner-name pre-check. Answering
    // "this name is taken here" to an unauthenticated, unverified caller told
    // anyone whether a named person studies at an academy. The admission
    // below is AUTOMATIC: a clash is admitted `name_unique_exempt` (audited),
    // the response is identical either way, and the person is asked to pick
    // a different display name only once signed in with a verified address
    // (`UsersService` → `academies[].nameChangeSuggested`).

    // An external (Google) account has no password: no credential row.
    const passwordHash = external
      ? null
      : await this.passwordCredentials.hashNew(input.password);
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    // The verification link is sent only where it is the ONLY proof of
    // mailbox control this account will give. When the sign-in surface it
    // was created for demands an emailed code (`new_device` / `always`), a
    // brand-new account has no trusted browser, so its first sign-in MUST
    // pass an OTP sent to this same address — and success sets
    // `emailVerifiedAt` (§12, `verifyEmailOtp`). A link as well would ask
    // twice for one fact. Under `off` nothing else proves the address, so
    // the link is still sent. `POST /auth/verify-email/resend` and the
    // link itself are unchanged.
    const signInSurface: SignInSurface = academyId ? 'academy' : 'management';
    const sendVerificationLink =
      !external?.emailVerified && this.emailOtpService.policyFor(signInSurface) === 'off';
    const rawVerificationToken = sendVerificationLink ? generateOpaqueToken() : null;
    const userId = randomUUID();

    const pendingApprovalOutboxIds: (string | null)[] = [];
    let organizationResult: SignupOrganizationResult | undefined;
    const organizationId = preparedOrganization ? randomUUID() : undefined;

    // P64 Phase 1 (Finding F4) — ONE transaction: the user row, the
    // academy membership and the verification-token outbox entry either
    // all exist or none do. The membership insert runs under the new
    // user's own identity (`academy_students_self_insert`), so the user
    // id is minted here and the RLS context set on the same connection.
    try {
      await this.prisma
        .$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
          await tx.user.create({
            data: {
              id: userId,
              email,
              name: input.name,
              // Google Identity — only an authoritative provider proves the mailbox.
              ...(external?.emailVerified ? { emailVerifiedAt: new Date() } : {}),
            },
          });
          if (passwordHash) {
            await this.passwordCredentials.storeHashed(tx, userId, passwordHash);
          }
          if (phone) {
            // Same transaction, same self context: the account and its number
            // exist together or not at all.
            await createPhoneForNewAccount(tx, userId, phone);
          }
          if (external) {
            await tx.userAuthIdentity.create({
              data: {
                userId,
                provider: external.provider,
                providerSubject: external.subject,
                emailAtLink: email,
              },
            });
            await this.auditLogWriterService.write(tx, {
              actorUserId: userId,
              action: 'auth.identity.linked',
              targetType: 'user',
              targetId: userId,
              ...(input.academyId ? { academyId: input.academyId } : {}),
              context: { provider: external.provider, via: 'new_account' },
            });
          }
          if (academyId && admission) {
            pendingApprovalOutboxIds.push(
              ...(await this.admitLearnerInTransaction(tx, {
                academyId,
                userId,
                admission,
                hostname: input.hostname,
                namePolicy: 'automatic',
              })),
            );
          }
          if (rawVerificationToken) {
            await tx.emailVerificationToken.create({
              data: {
                userId,
                tokenHash: hashOpaqueToken(rawVerificationToken),
                expiresAt: new Date(
                  Date.now() + identity.emailVerificationTokenTtlMinutes * 60 * 1000,
                ),
              },
            });
          }

          // New Customer Onboarding — the Organization, owner membership,
          // subscription and (when the mailbox is eligible) Free Trial, in THIS
          // transaction: the account and its organization exist together or not
          // at all. The tenant context is the organization id minted here — the
          // exact pair of contexts `POST /organizations` sets.
          if (preparedOrganization && organizationId && this.signupOrganizationPort) {
            await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true)`;
            organizationResult = await this.signupOrganizationPort.createInTransaction(
              tx,
              {
                organizationId,
                owner: { id: userId, email },
                prepared: preparedOrganization,
                context: input.context,
              },
            );
          }
        })
        .catch(async (error: unknown) => {
          // Two concurrent registrations of one address both pass the
          // `findByEmail` check above; the unique index decides, and the loser
          // gets the same 409 as the sequential case instead of a 500.
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002' &&
            (await this.isEmailConflict(error, email))
          ) {
            // Decision 3 — the loser of a race for a NEW address is answered
            // like any other registration (the Google path keeps its 409:
            // that address was proven by Google).
            if (!external) throw new RegistrationRaceLost();
            throw new ConflictException({
              messageKey: 'errors.auth.emailAlreadyRegistered',
            });
          }
          // W4 — a name conflict that escaped the in-transaction checks
          // (a writer that skipped the advisory lock): settled by asking,
          // as for the email, never disguised as a Google identity clash.
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            const nameConflict = await this.classifyRegistrationNameConflict({
              organizationName: preparedOrganization?.organizationName,
            });
            if (nameConflict) throw nameConflict;
          }
          // Google Identity — two first sign-ins racing with the same Google
          // account: the identity index decides.
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
          ) {
            throw new ConflictException({
              messageKey: 'errors.auth.googleIdentityInUse',
            });
          }
          throw error;
        });
    } catch (error) {
      if (error instanceof RegistrationRaceLost) return { account: 'new' };
      throw error;
    }

    for (const outboxId of organizationResult?.outboxIds ?? []) {
      await this.communicationService.enqueueAfterCommit(outboxId);
    }
    if (organizationResult && this.signupOrganizationPort) {
      await this.signupOrganizationPort.afterCommit(organizationResult);
    }
    recordSignup(
      metricMode,
      organizationResult
        ? organizationResult.trialStarted
          ? 'trial_started'
          : 'no_trial'
        : 'created',
    );

    for (const outboxId of pendingApprovalOutboxIds) {
      await this.communicationService.enqueueAfterCommit(outboxId);
    }

    // Delivery is best-effort AFTER commit: the account and its token
    // exist; a bad SMTP minute must not undo a registration, and the user
    // can re-request verification at any time.
    if (!rawVerificationToken) return { account: 'new' };
    try {
      const verificationOutboxId = await this.tenancyContextService.runInUserContext(
        userId,
        (tx) =>
          this.emitEmailVerification(tx, userId, rawVerificationToken, academyId ?? null),
      );
      await this.communicationService.enqueueAfterCommit(verificationOutboxId);
    } catch (error) {
      this.logger.warn(
        { userId, error: error instanceof Error ? error.message : error },
        'Could not send the verification email; the account exists and verification can be re-requested.',
      );
    }
    return { account: 'new' };
  }

  /**
   * The academy-membership write shared by a brand-new learner and an
   * existing account joining another academy (Launch Stabilization A4):
   * the `academy_students` row under the registration policy's admission,
   * and — for a `pending` admission — the approval work item for the
   * academy's moderators. Runs inside the caller's transaction, under the
   * LEARNER's own RLS context (`academy_students_self_insert`). Returns the
   * outbox ids to enqueue once that transaction commits.
   */
  private async admitLearnerInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      readonly academyId: string;
      readonly userId: string;
      readonly admission: {
        readonly status: 'active' | 'pending';
        readonly source: 'self_signup' | 'invite';
      };
      readonly hostname?: string;
      /**
       * W4 — `interactive` (an existing account that has proven its
       * password): a learner name already held in this academy is a 409 the
       * person can act on. `automatic` (a brand-new, unverified registration —
       * security review finding 2): never refused on the name; a clash is
       * admitted `name_unique_exempt` and audited, so the response cannot
       * reveal whether the name is taken.
       */
      readonly namePolicy: 'interactive' | 'automatic';
    },
  ): Promise<(string | null)[]> {
    const outboxIds: (string | null)[] = [];
    const { academyId, userId, admission } = input;
    const { student, nameClashExempted } = await this.academyStudentsRepository.admit(
      tx,
      {
        academyId,
        userId,
        status: admission.status,
        source: admission.source,
        registeredViaHost: input.hostname ?? null,
      },
      input.namePolicy === 'interactive'
        ? { mode: 'interactive', field: 'name' }
        : { mode: 'automatic' },
    );
    if (nameClashExempted) {
      const organizationId =
        await this.academyStudentsRepository.resolveOrganizationId(academyId);
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId: organizationId ?? undefined,
        academyId,
        action: 'academy.student.name_clash_exempted',
        targetType: 'user',
        targetId: userId,
        context: { source: admission.source },
      });
    }

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
        outboxIds.push(emitted.outboxId);
      }
    }
    return outboxIds;
  }

  /**
   * Launch Stabilization A4 — an EXISTING Atlas account signs up as a
   * learner at another academy.
   *
   * Two steps, kept apart on purpose:
   *
   *  1. EXISTING-ACCOUNT AUTHENTICATION. The password typed on the signup
   *     form must be the account's own password — verified exactly like a
   *     sign-in (argon2), against the same per-account budget as sign-in,
   *     so this endpoint is never a second, unmetered password oracle. A
   *     wrong password gets the SAME 409 an existing email has always got
   *     here, so nothing new is disclosed to someone who does not know it.
   *  2. NEW MEMBERSHIP CREATION. Only then is ONE `academy_students` row
   *     written, under the academy's registration policy (open / approval
   *     / invite, the invite bound to this account's email) — the same
   *     helper a brand-new learner goes through.
   *
   * Nothing else changes: no second user, no new password, no change to
   * name, email, verification, status, organization memberships, staff
   * roles or ownership. No session is minted — the person signs in on the
   * academy website next, under that academy's OTP and trusted-device
   * rules. The account owner is told by email (a leaked password must not
   * be able to quietly attach someone to academies).
   */
  /**
   * Decision 3 — the only place an existing address learns that somebody
   * tried to register it: an email to that address, at most one an hour
   * (catalogue dedupe window). Best-effort: a mail hiccup must not turn the
   * generic answer into a different one.
   */
  private async noticeSignupAttempt(user: User, academyId?: string): Promise<void> {
    if (user.status === 'deleted') return;
    try {
      const emitted = await this.tenancyContextService.runInUserContext(user.id, (tx) =>
        this.communicationService.emit(tx, {
          key: 'auth.account.signup_attempt',
          recipientUserId: user.id,
          organizationId: null,
          academyId: academyId ?? null,
          entity: { type: 'user', id: user.id },
          values: { window: String(Math.floor(Date.now() / 3_600_000)) },
        }),
      );
      await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    } catch (error) {
      this.logger.warn(
        {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not send the sign-up attempt notice (ignored).',
      );
    }
  }

  private async joinAcademyWithExistingAccount(
    user: User,
    email: string,
    input: Parameters<AuthService['register']>[0],
  ): Promise<RegistrationResult | null> {
    const passwordValid = await this.passwordCredentials.verify(user.id, input.password);
    if (!passwordValid) await this.signInThrottle.recordFailure(email);
    // Not proven (a wrong password, or an invited/deleted account that
    // cannot be joined to anything): the caller answers exactly as for a
    // new address and emails the owner — nothing is disclosed here.
    if (!passwordValid || user.status === 'deleted' || user.status === 'invited') {
      return null;
    }
    // Revealed only to someone who proved the password — as sign-in does.
    if (user.status === 'suspended') {
      throw new ForbiddenException({ messageKey: 'errors.auth.accountSuspended' });
    }

    const admitted = await this.admitExistingAccount(user, email, input);
    return { account: 'existing', status: admitted };
  }

  /**
   * Smart academy signup — `POST /auth/academy-join`: an EXISTING Atlas
   * account joins this academy as a learner, and nothing else. It is the
   * explicit, join-only twin of the A4 branch of `register` above, for the
   * signup page's "you already have an Atlas account — enter your password"
   * step, and it never creates an account.
   *
   * It is a sign-in in every respect that matters for enumeration: the same
   * `SignInRateLimitGuard` budget (per IP and per account), the same
   * dummy-hash verification for an unknown email, and the SAME generic 401
   * `invalidCredentials` for an unknown email, a wrong password, and an
   * invited or deleted account — so it answers nothing `POST /auth/sign-in`
   * does not already answer. The account's display name is returned only
   * after the password has been proven.
   */
  async joinAcademy(input: {
    email: string;
    password: string;
    academyId: string;
    inviteToken?: string;
    hostname?: string;
  }): Promise<AcademyJoinResult> {
    const email = normalizeEmail(input.email);
    const user = await this.usersRepository.findByEmail(email);
    if (!user) {
      await this.passwordCredentials.verifyForUnknownAccount(input.password);
      await this.signInThrottle.recordFailure(email);
      recordAcademyJoin('invalid_credentials');
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidCredentials' });
    }
    const passwordValid = await this.passwordCredentials.verify(user.id, input.password);
    if (!passwordValid) await this.signInThrottle.recordFailure(email);
    if (!passwordValid || user.status === 'deleted' || user.status === 'invited') {
      recordAcademyJoin('invalid_credentials');
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidCredentials' });
    }
    if (user.status === 'suspended') {
      recordAcademyJoin('refused');
      throw new ForbiddenException({ messageKey: 'errors.auth.accountSuspended' });
    }

    try {
      const status = await this.admitExistingAccount(user, email, input);
      recordAcademyJoin('joined');
      return { account: 'existing', status, name: user.name };
    } catch (error) {
      recordAcademyJoin(
        error instanceof ConflictException && !isNameConflict(error)
          ? 'already_learner'
          : 'refused',
      );
      throw error;
    }
  }

  /** The academy the request host resolves to (null on the management host). */
  hostAcademyId(hostname: string | undefined): Promise<string | null> {
    return this.academySurfaceService.resolveHostAcademyId(hostname);
  }

  /**
   * Smart academy signup — after an existing Atlas account has joined this
   * academy AND signed in here (its own password, then this academy's
   * emailed code), the page explains "you already use Atlas with <other
   * academy>". Naming another tenant is a disclosure, so it is gated at the
   * sign-in bar, not the password alone: an academy-website session for THIS
   * host's academy, whose learner row here was created moments ago. Anything
   * else — a management session, another academy's session, an old
   * membership — gets an empty list, never another academy's name. (An
   * academy session presented on ANOTHER academy's host is refused before
   * this, by the controller's A1 check.)
   */
  async academyJoinSummary(
    auth: {
      readonly userId: string;
      readonly surface: string | null;
      readonly academyId: string | null;
    },
    hostAcademyId: string | null,
  ): Promise<AcademyJoinSummary> {
    if (
      !hostAcademyId ||
      auth.surface !== 'academy' ||
      auth.academyId !== hostAcademyId
    ) {
      return { otherAcademies: [] };
    }
    const here = await this.tenancyContextService.runInUserContext(auth.userId, (tx) =>
      this.academyStudentsRepository.findForUserInAcademy(tx, hostAcademyId, auth.userId),
    );
    if (!here || Date.now() - here.joinedAt.getTime() > JOIN_SUMMARY_WINDOW_MS) {
      return { otherAcademies: [] };
    }
    const academies = await this.principalResolver.resolveLearnerAcademies(auth.userId);
    return {
      otherAcademies: academies
        .filter(
          (a) =>
            a.academyId !== hostAcademyId &&
            !a.blocked &&
            a.membershipStatus === 'active',
        )
        .map((a) => a.name),
    };
  }

  /**
   * The membership half of an existing account's academy join, shared by
   * `register` (A4) and `joinAcademy`: runs only once the caller has proven
   * the account's password. Resolves and checks the academy against the
   * request host, refuses a blocked or existing learner, and writes ONE
   * `academy_students` row under the academy's registration policy.
   */
  private async admitExistingAccount(
    user: User,
    email: string,
    input: {
      academyId?: string;
      inviteToken?: string;
      hostname?: string;
    },
  ): Promise<'active' | 'pending'> {
    const hostAcademyId = await this.academySurfaceService.resolveHostAcademyId(
      input.hostname,
    );
    if (hostAcademyId && !input.academyId) {
      throw new BadRequestException({ messageKey: 'errors.auth.academyContextRequired' });
    }
    await this.academySurfaceService.assertAcademyMatchesHost(
      input.academyId as string,
      input.hostname,
    );
    const academyId = (await this.resolveRegistrationAcademyId(
      input.academyId,
    )) as string;

    const already = await this.tenancyContextService.runInUserContext(user.id, (tx) =>
      this.academyStudentsRepository.findForUserInAcademy(tx, academyId, user.id),
    );
    if (already?.blockedAt) {
      throw new ForbiddenException({ messageKey: 'errors.auth.academyAccessBlocked' });
    }
    if (already) {
      throw new ConflictException({ messageKey: 'errors.auth.alreadyLearnerHere' });
    }

    const admission = await this.academySurfaceService.admissionForNewLearner(
      academyId,
      input.inviteToken,
      email,
    );

    // Task 3 — the join must carry its organization, or the academy's
    // activity log (tenant-scoped by organization) never shows it.
    const organizationId =
      (await this.academyStudentsRepository.resolveOrganizationId(academyId)) ??
      undefined;

    let outboxIds: (string | null)[] = [];
    try {
      outboxIds = await this.tenancyContextService.runInUserContext(
        user.id,
        async (tx) => {
          const ids = await this.admitLearnerInTransaction(tx, {
            academyId,
            userId: user.id,
            admission,
            hostname: input.hostname,
            namePolicy: 'interactive',
          });
          await this.auditLogWriterService.write(tx, {
            actorUserId: user.id,
            organizationId,
            academyId,
            action: 'academy.student.joined',
            targetType: 'user',
            targetId: user.id,
            context: {
              existingAccount: true,
              source: admission.source,
              status: admission.status,
            },
          });
          return ids;
        },
      );
    } catch (error) {
      // A concurrent second signup for the same academy: the unique index
      // on (academy, user) decides, and the loser gets the same answer as
      // the sequential case.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({ messageKey: 'errors.auth.alreadyLearnerHere' });
      }
      throw error;
    }
    for (const outboxId of outboxIds) {
      await this.communicationService.enqueueAfterCommit(outboxId);
    }
    recordSignup('account', 'existing_account_joined');
    await this.notifyAcademyJoined(user.id, academyId);
    return admission.status;
  }

  /**
   * Launch Stabilization A4 — tells the account owner their existing Atlas
   * account now has access to another academy. Best-effort, after commit:
   * the membership is already real, and a mail hiccup must not turn a
   * successful join into an error. The academy's name is read through the
   * learner's own definer-backed academy list (the learner context cannot
   * read `academies` directly).
   */
  private async notifyAcademyJoined(userId: string, academyId: string): Promise<void> {
    try {
      const academies = await this.principalResolver.resolveLearnerAcademies(userId);
      const academyName = academies.find((a) => a.academyId === academyId)?.name ?? '';
      const emitted: EmitResult = await this.tenancyContextService.runInUserContext(
        userId,
        (tx) =>
          this.communicationService.emit(tx, {
            key: 'account.academy.joined',
            recipientUserId: userId,
            academyId,
            entity: { type: 'academy_student', id: `${academyId}:${userId}` },
            values: { academyName },
          }),
      );
      await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    } catch (error) {
      this.logger.warn(
        { userId, academyId, error: error instanceof Error ? error.message : error },
        'Could not send the academy-joined notice; the membership itself was created.',
      );
    }
  }

  /**
   * Emits the verification event so the recipient gets a CTA button, not
   * a token. Runs inside the caller's user-context transaction.
   *
   * The legacy `EmailProvider.sendEmailVerification` pasted the raw token
   * into the body as `Verification token: <opaque>`, which is an internal
   * credential presented as if it were an instruction — a dead end for
   * the reader and English-only besides. `auth.email.verification` has
   * always existed in the catalogue with a bilingual template and an
   * `actionUrl`; it was simply never wired up. The token now travels
   * inside the link and is never displayed, and the dispatcher strips it
   * from the outbox row once the send is settled (`credentialValues`).
   *
   * `academyId` is set for an account created on (or resending from) an
   * academy website: the email then carries that academy's branding and
   * its link lands on the academy's own `/verify-email`, not on the
   * management host a learner is refused sign-in on. Never an
   * `organizationId` — that would make the row, and the live link in it,
   * visible to the tenant.
   */
  private async emitEmailVerification(
    tx: Prisma.TransactionClient,
    userId: string,
    rawToken: string,
    academyId: string | null,
  ): Promise<string | null> {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const emitted = await this.communicationService.emit(tx, {
      key: 'auth.email.verification',
      recipientUserId: userId,
      academyId,
      entity: { type: 'email_verification', id: userId },
      values: {
        // Consumed only by the catalogue's `actionUrl`, which puts it in
        // the href. No template prints it.
        token: rawToken,
        // The template states how long the link works.
        expiresInHours: Math.max(
          1,
          Math.round(identity.emailVerificationTokenTtlMinutes / 60),
        ),
        // Selects the academy-host destination in `actionUrl`.
        ...(academyId ? { academyId } : {}),
      },
    });
    return emitted.outboxId;
  }

  /**
   * Completes verification.
   *
   * Single-use and replay-proof: the token is claimed with a conditional
   * UPDATE that only matches a row which is unexpired and not yet used,
   * and the address is marked verified in the SAME transaction (see
   * `EmailVerificationTokensRepository.consume`). Two concurrent
   * submissions of the same link serialise on the row; exactly one wins.
   *
   * Malformed and unknown tokens are indistinguishable — both are refused
   * as `invalidVerificationToken` before or after a hash lookup that
   * finds nothing. Only a token whose hash matched a real row (so only
   * the holder of the emailed link) is told it expired or was already
   * used, which lets the page say something useful without turning the
   * endpoint into a probe.
   */
  async verifyEmail(rawToken: string, callerUserId: string | null): Promise<void> {
    const outcome = VERIFICATION_TOKEN_FORMAT.test(rawToken)
      ? await this.emailVerificationTokensRepository.consume(
          hashOpaqueToken(rawToken),
          callerUserId,
        )
      : ({ status: 'invalid' } as const);

    if (outcome.status === 'verified') return;
    if (outcome.status === 'signInRequired') {
      throw new ForbiddenException({
        messageKey: VERIFICATION_FAILURE_MESSAGE_KEYS.signInRequired,
      });
    }
    throw new BadRequestException({
      messageKey: VERIFICATION_FAILURE_MESSAGE_KEYS[outcome.status],
    });
  }

  /**
   * Re-sends verification for the signed-in account.
   *
   * Always reports success, even when the account is already verified —
   * the caller is authenticated, so there is nothing to disclose, and a
   * uniform response keeps the client simple. Rate limiting lives on the
   * controller (`EmailVerificationResendRateLimitGuard`): this is an
   * endpoint that sends mail on demand.
   *
   * Rotation and the outbox entry are ONE transaction under a lock on the
   * user row (`rotateForUser`): concurrent resends serialise, so exactly
   * one link is ever live, and a failed emit leaves the previous link
   * working instead of retiring it with no replacement sent.
   */
  async resendEmailVerification(
    userId: string,
    options: { readonly academyId?: string | null } = {},
  ): Promise<void> {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const rawToken = generateOpaqueToken();
    try {
      const outboxId = await this.tenancyContextService.runInUserContext(
        userId,
        async (tx) => {
          const rotated = await this.emailVerificationTokensRepository.rotateForUser(tx, {
            userId,
            tokenHash: hashOpaqueToken(rawToken),
            expiresAt: new Date(
              Date.now() + identity.emailVerificationTokenTtlMinutes * 60 * 1000,
            ),
          });
          if (!rotated) return null;
          return this.emitEmailVerification(
            tx,
            userId,
            rawToken,
            options.academyId ?? null,
          );
        },
      );
      await this.communicationService.enqueueAfterCommit(outboxId);
    } catch (error) {
      // Logged WITHOUT the token — the raw value must never reach a log
      // sink, since it is a live credential until used or expired.
      this.logger.warn(
        { userId, error: error instanceof Error ? error.message : error },
        'Could not send the verification email; the account exists and verification can be re-requested.',
      );
    }
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

    // ATO F7 — every failed password counts toward the address's
    // account-wide ceiling, known address or not (counting only known ones
    // would make the ceiling an existence oracle).
    if (!user) {
      await this.passwordCredentials.verifyForUnknownAccount(input.password);
      await this.signInThrottle.recordFailure(email);
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidCredentials' });
    }

    const passwordValid = await this.passwordCredentials.verify(user.id, input.password);
    if (!passwordValid) {
      await this.signInThrottle.recordFailure(email);
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidCredentials' });
    }

    return this.continueSignIn(
      user,
      { surface: input.surface ?? 'management', academyId: input.academyId },
      input.context,
      'password',
    );
  }

  /**
   * Google Identity — everything a sign-in does AFTER its first factor has
   * proven the person, shared by the password (`signIn`) and Google paths so
   * both go through ONE pipeline: account status → surface resolution
   * (host + registration policy) → TOTP → the emailed code / trusted device
   * (A6) → `issueSession`. Extracted from `signIn` unchanged; the only new
   * thing is `authMethod`, which rides through the challenges to the
   * session it mints. A first factor never skips any step here.
   */
  async continueSignIn(
    user: User,
    requested: SessionSurfaceSelection,
    context: SessionRequestContext | undefined,
    authMethod: AuthMethod,
  ): Promise<AuthenticationResponseContract> {
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

    // Launch Stabilization A2 (D2) — an account somebody else created has a
    // password nobody knows until its owner sets one through the emailed
    // setup link. Refused exactly like a wrong password, so nothing about
    // the account's state is disclosed.
    if (user.status === 'invited') {
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
    const selection = await this.resolveSurface(user, requested, context);

    if (await this.twoFactorService.isEnforcedFor(user.id)) {
      const challenge = await this.twoFactorService.createChallenge(
        user.id,
        authMethod,
        selection.surface === 'academy' && selection.academyId
          ? { surface: 'academy', academyId: selection.academyId }
          : { surface: 'management' },
      );
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
        academyId: selection.academyId,
        trustCookie: context?.trustCookie,
        minimumPolicy: await this.privilegedEmailOtpFloor(user, selection.surface),
      })
    ) {
      const challenge = await this.emailOtpService.issue({
        user,
        surface: selection.surface,
        academyId: selection.academyId,
        context,
        authMethod,
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

    const session = await this.issueSession(user, context, selection, authMethod);
    await this.usersRepository.touchLastSignInAt(user.id);

    return session;
  }

  /**
   * ATO review F11 — a Platform Owner, or anyone who owns an organization,
   * signing in to the management surface without a confirmed authenticator
   * app (that branch returned above) gets AT LEAST the configured floor
   * (`new_device` by default), whatever `FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT`
   * says — so a phished or reused password alone never opens the whole
   * platform or an organization's money and staff. Academy-surface sessions
   * carry learner access only and keep the academy policy.
   */
  private async privilegedEmailOtpFloor(
    user: User,
    surface: SignInSurface,
  ): Promise<EmailOtpPolicy | undefined> {
    if (surface !== 'management') return undefined;
    const floor =
      this.configService.getOrThrow<IdentityConfig>('identity').emailOtp.privilegedFloor;
    if (floor === 'off') return undefined;
    if (user.isPlatformOwner) return floor;
    const principal = await this.principalResolver.resolve(user.id);
    return principal.ownsAnOrganization ? floor : undefined;
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
    // W4 — an AUTOMATIC admission: sign-in must never fail on a learner-name
    // clash. The row is inserted `name_unique_exempt` and the clash recorded.
    const organizationId =
      await this.academyStudentsRepository.resolveOrganizationId(academyId);
    await this.tenancyContextService.runInUserContext(user.id, async (tx) => {
      const { nameClashExempted } = await this.academyStudentsRepository.admit(
        tx,
        {
          academyId,
          userId: user.id,
          status: 'active',
          source: 'sign_in_join',
          registeredViaHost: context?.hostname ?? null,
        },
        { mode: 'automatic' },
      );
      if (nameClashExempted) {
        await this.auditLogWriterService.write(tx, {
          actorUserId: user.id,
          organizationId: organizationId ?? undefined,
          academyId,
          action: 'academy.student.name_clash_exempted',
          targetType: 'user',
          targetId: user.id,
          context: { source: 'sign_in_join' },
        });
      }
    });
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
    // Like the emailed code: the challenge records the surface/academy the
    // sign-in was resolved for, and it must be completed on that host.
    const expected = await this.academySurfaceService.expectedAuthContext(
      context?.hostname,
    );
    const {
      userId,
      authMethod,
      selection: challenged,
    } = await this.twoFactorService.completeChallenge(challengeId, input, expected);

    const user = await this.usersRepository.findById(userId);
    if (!user) {
      // The account vanished between password and second factor. Same
      // generic failure as a bad code — nothing is disclosed.
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidTwoFactorCode' });
    }

    // P64 Phase 1 — the surface is re-resolved here, so a learner can no
    // more finish a management sign-in through 2FA than start one. It is
    // the CHALLENGE's surface, never the body's; the body is read only for
    // a challenge minted before challenges recorded one.
    const selection = await this.resolveSurface(user, challenged ?? requested, context);
    const session = await this.issueSession(user, context, selection, authMethod);
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
    // Launch Stabilization A6 — the code must be completed where it was
    // issued for: the context comes from the request HOST, and a mismatch is
    // answered like a wrong code.
    const expected = await this.academySurfaceService.expectedAuthContext(
      context?.hostname,
    );
    const verified = await this.emailOtpService.verify(
      challengeId,
      code,
      { ipAddress: context?.ipAddress, userAgent: context?.userAgent },
      expected,
    );

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
    const session = await this.issueSession(
      user,
      context,
      selection,
      verified.authMethod,
    );
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
      await this.rememberDevice(user.id, selection.surface, context, selection.academyId);
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
    academyId?: string,
  ): Promise<void> {
    try {
      const minted = await this.trustedDeviceService.trust({
        userId,
        surface,
        academyId,
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

    const days = (n: number) => n * 24 * 60 * 60 * 1000;
    const result = await this.refreshTokensRepository.rotate(
      presentedHash,
      {
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
      },
      {
        management: days(identity.sessionAbsoluteMaxDays.management),
        academy: days(identity.sessionAbsoluteMaxDays.academy),
      },
    );

    if (!result) {
      // A token that was already rotated away and is presented again later
      // means two parties hold the same session: the whole family ends
      // (refresh rows and live access tokens), whoever holds it. A benign
      // concurrent-refresh race (within the grace) just fails.
      const reused = await this.refreshTokensRepository.findReusedRotation(
        presentedHash,
        REFRESH_REUSE_GRACE_MS,
      );
      if (reused) {
        const revoked = await this.refreshTokensRepository.revokeSessionForUser(
          reused.sessionId,
          reused.userId,
        );
        await this.sessionRevocationService.markRevoked(reused.sessionId);
        recordSessionsRevoked('refresh_token_reuse', revoked > 0 ? 1 : 0);
        this.logger.warn(
          { event: 'auth.refresh.reuse_detected', userId: reused.userId, revoked },
          'A rotated refresh token was presented again; its session was ended.',
        );
        await this.tenancyContextService.runInUserContext(reused.userId, (tx) =>
          this.auditLogWriterService.writeBestEffort(tx, {
            actorUserId: reused.userId,
            action: 'auth.sessions.revoked',
            targetType: 'user',
            targetId: reused.userId,
            context: {
              trigger: 'refresh_token_reuse',
              sessionsRevoked: revoked > 0 ? 1 : 0,
            },
          }),
        );
      }
      // Stale-tab recovery — a token a concurrent request rotated a moment
      // ago (inside the grace): the same 401, but flagged so the controller
      // leaves the browser's newer session cookie alone.
      if (
        !reused &&
        (await this.refreshTokensRepository.findReusedRotation(presentedHash, 0))
      ) {
        throw new SupersededRefreshTokenException();
      }
      // Covers: unknown token, already-revoked token, and expired token —
      // all collapse to the same generic 401, never distinguishing which,
      // so a caller can't probe for which failure mode applies.
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidRefreshToken' });
    }

    // ATO review F10 — the session reached its absolute maximum: the
    // presented token was spent, no replacement was made, and the rest of
    // the family ends now. The same generic 401 as any dead refresh token;
    // the person simply signs in again. Not reuse — no reuse audit.
    const created = result.created;
    if (!created) {
      await this.refreshTokensRepository.revokeSessionForUser(
        result.claimed.sessionId,
        result.claimed.userId,
      );
      await this.sessionRevocationService.markRevoked(result.claimed.sessionId);
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidRefreshToken' });
    }

    // A session outlives nothing about its account: once the account is no
    // longer active (suspended, deleted, back to invited), a refresh ends the
    // session instead of renewing it — the same refusal a new sign-in gets.
    const owner = await this.usersRepository.findById(created.userId);
    if (!owner || owner.status !== 'active') {
      await this.refreshTokensRepository.revokeSessionForUser(
        created.sessionId,
        created.userId,
      );
      await this.sessionRevocationService.markRevoked(created.sessionId);
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
      sub: created.userId,
      sid: created.sessionId,
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
   * Sign-out when the page no longer holds a valid access token: the
   * session is identified by the refresh token in its HttpOnly cookie. The
   * owner is found by the token's hash (never from the request), the whole
   * rotation family is revoked and its access tokens denied. An unknown or
   * already-revoked token is a silent no-op — signing out of nothing is not
   * an error.
   */
  async signOutByRefreshToken(rawRefreshToken: string): Promise<void> {
    const session = await this.refreshTokensRepository.findSessionOfToken(
      hashOpaqueToken(rawRefreshToken),
    );
    if (!session) return;
    await this.refreshTokensRepository.revokeSessionForUser(
      session.sessionId,
      session.userId,
    );
    await this.sessionRevocationService.markRevoked(session.sessionId);
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
   *
   * Production QA Issue 5 — the request host's academy travels with the
   * job, so a reset asked for on an academy website returns its reader to
   * that academy's own reset page. It is resolved BEFORE the account
   * lookup, for every request, so a known and an unknown address cost the
   * same; whether the account belongs to that academy is decided later, in
   * the worker (`recoveryAcademyId`), never here.
   */
  async requestPasswordReset(
    email: string,
    context: { readonly hostname?: string } = {},
  ): Promise<void> {
    const hostAcademyId = await this.academySurfaceService.resolveHostAcademyId(
      context.hostname,
    );
    // ATO review F9 — the same work for every address: one queue add. The
    // account lookup, the token and the email happen in the worker, so
    // neither the response time nor an error can tell an address with an
    // account from one without ("If an account exists with that email…").
    await this.passwordResetEmailProducer.enqueue({
      kind: 'request',
      email: normalizeEmail(email),
      ...(hostAcademyId ? { hostAcademyId } : {}),
    });
  }

  /**
   * Validates + consumes a reset token, rotates the password, and revokes
   * every existing refresh token for the account (master plan §8/§21 P1) —
   * unlike `signOut`, this is a deliberate all-sessions revocation, because
   * a password reset is exactly the scenario where every existing session
   * should be treated as no-longer-trusted.
   */
  async confirmPasswordReset(
    rawToken: string,
    newPassword: string,
    context: { readonly hostname?: string } = {},
  ): Promise<void> {
    const tokenHash = hashOpaqueToken(rawToken);
    // A cheap read first, so an unknown token never costs a password hash.
    if (!(await this.passwordResetTokensRepository.findValidByHash(tokenHash))) {
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidResetToken' });
    }
    const passwordHash = await this.passwordCredentials.hashNew(newPassword);
    // Then ONE conditional write consumes it: a link confirmed twice
    // concurrently is honoured once, never twice.
    const resetToken =
      await this.passwordResetTokensRepository.claimValidByHash(tokenHash);

    if (!resetToken) {
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidResetToken' });
    }
    const owner = await this.usersRepository.findById(resetToken.userId);
    if (!owner || owner.status === 'deleted') {
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidResetToken' });
    }

    await this.tenancyContextService.runInUserContext(resetToken.userId, (tx) =>
      this.passwordCredentials.storeHashed(tx, resetToken.userId, passwordHash),
    );
    // Any other outstanding reset/setup link for this account dies with it.
    await this.passwordResetTokensRepository.spendAllForUser(resetToken.userId);
    // Launch Stabilization A2 (D2) — the setup link for an account staff
    // created is this same reset token: setting a password here is what
    // activates an `invited` account, and the link reaching the inbox
    // proves the address.
    await this.usersRepository.completeInvitation(resetToken.userId, new Date());
    // ATO review F1/F2 — the reset proved the mailbox. On an account that
    // had NEVER been proven, the external sign-in and 2FA on it were set by
    // whoever held the password without that proof: they go, and the
    // address is recorded as verified. A proven account keeps its 2FA —
    // a reset must never be a way around the second factor.
    await this.unprovenAccountService.afterFirstMailboxProof(
      resetToken.userId,
      new Date(),
    );
    // Launch Stabilization A3 (D3) — refresh rows AND live access tokens.
    const sessionsRevoked = await this.sessionRevocationService.revokeAllSessionsForUser(
      resetToken.userId,
      'password_reset',
    );
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
    // Launch Stabilization A3 — the durable security record of what the
    // reset ended. Best-effort in its own small user-context transaction:
    // the revocations above have already happened and an audit failure
    // must never undo or block them.
    await this.tenancyContextService.runInUserContext(resetToken.userId, (tx) =>
      this.auditLogWriterService.writeBestEffort(tx, {
        actorUserId: resetToken.userId,
        action: 'auth.sessions.revoked',
        targetType: 'user',
        targetId: resetToken.userId,
        context: {
          trigger: 'password_reset',
          sessionsRevoked,
          trustedDevicesRevoked: forgotten,
        },
      }),
    );

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
    // Confirmed on an academy website by one of that academy's own
    // accounts → the notice carries that academy's brand and its "wasn't
    // you?" link returns to that academy's forgot-password page. The
    // caller already holds this account's reset token, so the lookup tells
    // them nothing new.
    // Best-effort, like the audit writes above: the password is already
    // changed and every session revoked, so a failed lookup must not turn
    // a completed reset into an error — the notice then goes out as the
    // management one.
    const academyId = await this.resetNoticeAcademyId(
      resetToken.userId,
      context.hostname,
    );
    const emitted: EmitResult = await this.tenancyContextService.runInUserContext(
      resetToken.userId,
      (tx) =>
        this.communicationService.emit(tx, {
          key: 'auth.password.reset_confirmed',
          recipientUserId: resetToken.userId,
          academyId,
          entity: { type: 'user', id: resetToken.userId },
          ...(academyId ? { values: { academyId } } : {}),
        }),
    );
    await this.communicationService.enqueueAfterCommit(emitted.outboxId);
  }

  /** The academy the "password was reset" notice belongs to, or `null` (management) — never throws. */
  private async resetNoticeAcademyId(
    userId: string,
    hostname: string | undefined,
  ): Promise<string | null> {
    try {
      const hostAcademyId =
        await this.academySurfaceService.resolveHostAcademyId(hostname);
      if (!hostAcademyId) return null;
      return recoveryAcademyId(
        await this.principalResolver.resolve(userId),
        hostAcademyId,
      );
    } catch (error) {
      this.logger.warn(
        { userId, error: error instanceof Error ? error.message : error },
        'Could not resolve the academy for the password-reset notice; sending the management one.',
      );
      return null;
    }
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
          // registered/removed"). `created` is true on exactly one path —
          // the INSERT — so this fires for a genuinely new browser and not
          // for the cap refusal (which still issues the browser an
          // identity) or a recognised device being touched. In-app only by
          // the catalogue: the learner is sitting at the browser that was
          // just registered, and §10's own note for this row is "low volume".
          if (resolution.created && resolution.device) {
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
    context: SessionRequestContext | undefined,
    selection: SessionSurfaceSelection,
    authMethod: AuthMethod,
  ): Promise<AuthenticationSessionContract> {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const rawRefreshToken = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(rawRefreshToken);
    // ATO review F10 — never longer than the surface's absolute maximum.
    const expiresAt = new Date(
      Date.now() +
        Math.min(
          identity.refreshTokenTtlDays,
          identity.sessionAbsoluteMaxDays[selection.surface],
        ) *
          24 *
          60 *
          60 *
          1000,
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
      authMethod,
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
      authMethod,
      // Launch Stabilization A5 — a session minted on an academy website
      // is told only about that academy.
      user: scopeCurrentUserToSession(
        toCurrentUser(user, organizationMemberships, {
          ...principal,
          managementSurfaceEnforced: this.surfaceEnforcement.isEnforcedFor(principal),
        }),
        { surface: selection.surface, academyId: selection.academyId ?? null },
      ),
    };
  }
}

/** The unique-index columns a P2002 names, when PostgreSQL reports them. */
function uniqueTargetFields(error: Prisma.PrismaClientKnownRequestError): string[] {
  const target = error.meta?.target;
  return Array.isArray(target)
    ? target.map(String)
    : typeof target === 'string'
      ? [target]
      : [];
}

/** Decision 3 — a concurrent registration of the same new address won the race. */
class RegistrationRaceLost extends Error {}
