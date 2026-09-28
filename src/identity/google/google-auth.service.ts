/**
 * Google Identity — the sign-in flow (docs/GOOGLE_IDENTITY.md).
 *
 *   1. authorize (on the ORIGIN host: platform, academy subdomain or custom
 *      domain) — the surface and academy come from the request HOST; a flow
 *      row stores hashed state/nonce/binder, the PKCE verifier and the
 *      origin; the browser gets a host-only binder cookie and Google's URL.
 *   2. callback (on the PLATFORM host — the one registered redirect URI) —
 *      spends the state, exchanges the code, verifies the ID token, stores
 *      the verified claims and a single-use handoff, and sends the browser
 *      back to the origin it came from (and only there), handoff in the URL
 *      FRAGMENT so it never reaches a server log or a Referer.
 *   3. complete (on the ORIGIN host again) — the same browser (binder
 *      cookie) spends the handoff; the Google identity resolves to ONE
 *      global Atlas account by its subject, and the sign-in continues
 *      through `AuthService.continueSignIn`: surface/academy rules, TOTP,
 *      the emailed code (A6) and trusted devices exactly as for a password.
 *
 * An email match is NEVER a link: an address that belongs to an Atlas
 * account whose owner never connected Google yields a follow-up step in
 * which the owner must prove that account first. Nothing is created here.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AuthOAuthFlow, User } from '@prisma/client';
import type {
  AppConfig,
  GoogleAuthConfig,
  IdentityConfig,
} from '../../config/configuration';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { AuthRateLimiterService } from '../services/auth-rate-limiter.service';
import { PasswordHasherService } from '../services/password-hasher.service';
import { PasswordResetTokensRepository } from '../repositories/password-reset-tokens.repository';
import { hashOpaqueToken } from '../utils/opaque-token.util';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { recordGoogleAuth } from '../../observability/metrics/google-auth-metrics';
import type { AuthenticationResponseContract } from '../dto/contracts';
import { UsersRepository } from '../repositories/users.repository';
import { AcademySurfaceService } from '../services/academy-surface.service';
import {
  AuthService,
  NO_PASSWORD_PREFIX,
  hasUsablePassword,
  type SessionRequestContext,
} from '../services/auth.service';
import { GoogleIdentityRepository } from './google-identity.repository';
import { GoogleOidcClient, GoogleOidcError } from './google-oidc.client';
import {
  flowSecretMatches,
  hashFlowSecret,
  isGoogleAuthoritative,
  newFlowSecret,
  pkceChallenge,
  sanitizeReturnPath,
} from './google-flow.util';

/** Start → Google → callback. */
const FLOW_TTL_MS = 10 * 60 * 1000;
/** `auth_oauth_flows` rows are deleted once their lifetime ended this long ago (matches the table's 24 h retention policy). */
const FLOW_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Callback → complete: one redirect, then one request. */
const HANDOFF_TTL_MS = 2 * 60 * 1000;
/** A follow-up step (link / create / activate) waiting for the person. */
const PENDING_TTL_MS = 10 * 60 * 1000;
/**
 * A follow-up step's secret shares the handoff column but is a different
 * stage: it carries this prefix (inside the hash, so it cannot be added or
 * stripped), `complete` refuses it, and only the step endpoints accept it.
 */
export const PENDING_PREFIX = 'p.';

/**
 * `sign_in` / `sign_up`: signed-out pages. `link`: Account settings — a
 * signed-in person connects Google to THEIR account (the account is the
 * session's, bound at authorize). `setup`: the invitation/setup page — the
 * emailed setup token proves the mailbox, and Google becomes the account's
 * sign-in instead of a password.
 */
export type GoogleIntent = 'sign_in' | 'sign_up' | 'link' | 'setup';

/** What the SPA needs to show the next step. Never another account's data. */
export interface GoogleStepContract {
  readonly googleStep: 'link_required' | 'create_account' | 'activate_invited';
  /** Single-use reference to this flow for the step's own endpoint. */
  readonly pending: string;
  readonly expiresAt: string;
  /** The address the person just proved at Google — their own. */
  readonly email: string;
  /** `create_account` only: Google's display name, to prefill. */
  readonly name?: string;
  readonly returnPath?: string;
}

/** `link` intent: the signed-in account now has this Google account. No session is minted. */
export interface GoogleLinkedContract {
  readonly linked: true;
  readonly email: string;
  readonly returnPath?: string;
}

export type GoogleSignInResponse = AuthenticationResponseContract & {
  readonly returnPath?: string;
};

export type GoogleCompleteResponse =
  GoogleSignInResponse | GoogleStepContract | GoogleLinkedContract;

/** `GET /users/me/sign-in-methods`. */
export interface SignInMethodsContract {
  readonly password: boolean;
  readonly google: { readonly email: string; readonly linkedAt: string } | null;
}

/** What a step endpoint needs of the request, beyond its own body. */
export interface StepRequest {
  readonly pending: string;
  readonly binder: string | undefined;
  readonly origin: string | null;
  readonly context: SessionRequestContext;
  /** An `invite`-policy academy sign-up's invitation code (see `finishSignIn`). */
  readonly inviteToken?: string;
}

/** Where the callback sends the browser. */
export interface GoogleCallbackOutcome {
  readonly redirectTo?: string;
  /** Set when no flow could be identified — there is nowhere safe to send the browser. */
  readonly deadEnd?: true;
}

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly oidc: GoogleOidcClient,
    private readonly repository: GoogleIdentityRepository,
    private readonly academySurface: AcademySurfaceService,
    private readonly academyStudents: AcademyStudentsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly authService: AuthService,
    private readonly tenancyContext: TenancyContextService,
    private readonly auditLog: AuditLogWriterService,
    private readonly communications: CommunicationService,
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly passwordHasher: PasswordHasherService,
    private readonly passwordResetTokens: PasswordResetTokensRepository,
  ) {}

  private get config(): GoogleAuthConfig {
    return this.configService.getOrThrow<GoogleAuthConfig>('googleAuth');
  }

  private get isProduction(): boolean {
    return this.configService.getOrThrow<AppConfig>('app').nodeEnv === 'production';
  }

  /**
   * Whether Google sign-in is offered for this surface (flag + credentials).
   * `allowlist`: an academy only when listed; the platform host (Atlas's own
   * sign-in/sign-up — the management surface) only with its own explicit
   * switch, so listing academies never turns it on by accident.
   */
  isEnabledFor(surface: 'management' | 'academy', academyId?: string | null): boolean {
    const { mode, academyIds, platform } = this.config;
    if (mode === 'off' || !this.oidc.isConfigured()) return false;
    if (mode === 'on') return true;
    if (surface === 'management') return platform;
    return !!academyId && academyIds.includes(academyId);
  }

  /** Any surface at all — the routes answer 404 while this is false. */
  isAvailable(): boolean {
    return this.config.mode !== 'off' && this.oidc.isConfigured();
  }

  /**
   * The web origin (`scheme://host[:port]`) a request belongs to. In
   * production it is the request's own origin and a browser `Origin` header
   * naming anything else is refused; locally the SPA may run on a CORS-
   * allowed origin that differs from the API's.
   */
  requestOrigin(input: {
    readonly protocol: string;
    readonly host: string | undefined;
    readonly originHeader: string | undefined;
  }): string | null {
    if (!input.host) return null;
    const self = `${input.protocol}://${input.host.toLowerCase()}`;
    const origin = input.originHeader?.trim().toLowerCase();
    if (!origin || origin === 'null') return self;
    if (origin === self) return self;
    if (!this.isProduction) {
      const allowed = this.configService.getOrThrow<AppConfig>('app').corsAllowedOrigins;
      if (allowed.map((o) => o.toLowerCase()).includes(origin)) return origin;
    }
    return null;
  }

  /** Where a flow on this host signs in to — derived from the HOST, never the body. */
  private async resolveContext(
    hostname: string | undefined,
    previewAcademyId: string | undefined,
  ): Promise<{ surface: 'management' | 'academy'; academyId: string | null }> {
    const hostAcademyId = await this.academySurface.resolveHostAcademyId(hostname);
    if (hostAcademyId) {
      if (previewAcademyId && previewAcademyId !== hostAcademyId) {
        throw new ForbiddenException({ messageKey: 'errors.auth.academyHostMismatch' });
      }
      return { surface: 'academy', academyId: hostAcademyId };
    }
    if (!(await this.academySurface.isUnresolvableHost(hostname))) {
      // A host that is neither the platform, local, nor a live academy.
      throw new BadRequestException({ messageKey: 'errors.auth.academyContextRequired' });
    }
    if (!previewAcademyId) return { surface: 'management', academyId: null };
    // Platform host / local development: the page names its academy, as
    // the password sign-in's preview parameter does. It must exist.
    const organizationId =
      await this.academyStudents.resolveOrganizationId(previewAcademyId);
    if (!organizationId)
      throw new NotFoundException({ messageKey: 'errors.academy.notFound' });
    return { surface: 'academy', academyId: previewAcademyId };
  }

  /** Step 1 — returns Google's URL and the binder the controller sets as a cookie. */
  async authorize(input: {
    readonly intent: GoogleIntent;
    readonly returnTo?: string;
    readonly academyId?: string;
    readonly hostname: string | undefined;
    readonly origin: string | null;
    readonly ipAddress?: string;
    /** `link`: the signed-in account (from the verified access token, never the body). */
    readonly signedInUserId?: string;
    /** `setup`: the raw setup token from the invitation link. */
    readonly setupToken?: string;
    /** `link`: the account's current password (re-authentication). */
    readonly currentPassword?: string;
  }): Promise<{ authorizationUrl: string; binder: string; expiresAt: Date }> {
    if (!this.isAvailable()) {
      recordGoogleAuth('authorize', 'disabled');
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    if (!input.origin || (this.isProduction && !input.origin.startsWith('https://'))) {
      throw new ForbiddenException({ messageKey: 'errors.auth.googleOriginRefused' });
    }
    const context = await this.resolveContext(input.hostname, input.academyId);
    if (!this.isEnabledFor(context.surface, context.academyId)) {
      recordGoogleAuth('authorize', 'disabled');
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    const linkUserId = await this.bindingUserFor(input);

    const state = newFlowSecret();
    const nonce = newFlowSecret();
    const binder = newFlowSecret();
    const codeVerifier = newFlowSecret();
    const expiresAt = new Date(Date.now() + FLOW_TTL_MS);

    await this.repository.createFlow({
      stateHash: hashFlowSecret(state),
      nonceHash: hashFlowSecret(nonce),
      binderHash: hashFlowSecret(binder),
      codeVerifier,
      intent: input.intent,
      surface: context.surface,
      academyId: context.academyId,
      originHost: input.origin,
      returnPath: sanitizeReturnPath(input.returnTo),
      linkUserId,
      ipAddress: input.ipAddress ?? null,
      expiresAt,
    });
    recordGoogleAuth('authorize', 'started');
    await this.pruneOldFlows();

    return {
      authorizationUrl: this.oidc.authorizationUrl({
        state,
        nonce,
        codeChallenge: pkceChallenge(codeVerifier),
      }),
      binder,
      expiresAt,
    };
  }

  /**
   * Retention for `auth_oauth_flows` (24 h, docs/GOOGLE_IDENTITY.md §3):
   * every new flow sweeps a bounded batch of old ones, so deletion keeps
   * pace with creation without a separate job. Best-effort — a failed
   * sweep never fails a sign-in; the next flow retries.
   */
  private async pruneOldFlows(): Promise<void> {
    try {
      await this.repository.pruneExpired(new Date(), FLOW_RETENTION_MS);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : 'error' },
        'Google flow retention sweep failed; the next flow retries.',
      );
    }
  }

  /** Only the platform host (or a local development host) is a callback host. */
  async isCallbackHost(hostname: string | undefined): Promise<boolean> {
    return this.academySurface.isUnresolvableHost(hostname);
  }

  /**
   * Step 2 — Google redirected here. Every path either sends the browser
   * back to the origin stored on the flow row, or — when no flow can be
   * identified — nowhere (`deadEnd`).
   */
  async callback(input: {
    readonly code?: string;
    readonly state?: string;
    readonly error?: string;
  }): Promise<GoogleCallbackOutcome> {
    if (!this.isAvailable()) {
      recordGoogleAuth('callback', 'disabled');
      return { deadEnd: true };
    }
    if (!input.state) {
      recordGoogleAuth('callback', 'invalid_state');
      return { deadEnd: true };
    }
    const now = new Date();
    const flow = await this.repository.claimState(hashFlowSecret(input.state), now);
    if (!flow) {
      recordGoogleAuth('callback', 'invalid_state');
      return { deadEnd: true };
    }

    if (input.error || !input.code) {
      const cancelled = input.error === 'access_denied';
      recordGoogleAuth('callback', cancelled ? 'cancelled' : 'provider_error');
      await this.repository.markCompleted(flow.id, now);
      return {
        redirectTo: this.returnUrl(flow, { error: cancelled ? 'cancelled' : 'failed' }),
      };
    }

    try {
      const claims = await this.oidc.exchangeAndVerify({
        code: input.code,
        codeVerifier: flow.codeVerifier,
        nonceHash: flow.nonceHash,
      });
      const handoff = newFlowSecret();
      await this.repository.recordClaims(
        flow.id,
        {
          providerSubject: claims.subject,
          providerEmail: claims.email,
          providerEmailVerified: claims.emailVerified,
          providerHostedDomain: claims.hostedDomain,
          providerName: claims.name,
        },
        {
          hash: hashFlowSecret(handoff),
          expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
        },
      );
      return { redirectTo: this.returnUrl(flow, { h: handoff }) };
    } catch (error) {
      const kind = error instanceof GoogleOidcError ? error.kind : 'provider_error';
      // Never the code, the token or the claims — only what failed.
      this.logger.warn(
        {
          flowId: flow.id,
          kind,
          reason: error instanceof Error ? error.message : 'error',
        },
        'Google sign-in callback failed.',
      );
      recordGoogleAuth('callback', kind);
      await this.repository.markCompleted(flow.id, new Date());
      return { redirectTo: this.returnUrl(flow, { error: 'failed' }) };
    }
  }

  private returnUrl(flow: AuthOAuthFlow, fragment: Record<string, string>): string {
    return `${flow.originHost}/auth/google/return#${new URLSearchParams(fragment).toString()}`;
  }

  /**
   * Step 3 — the browser that started the flow presents the handoff on the
   * origin it started from.
   */
  async complete(input: {
    readonly handoff: string;
    readonly binder: string | undefined;
    readonly origin: string | null;
    readonly context: SessionRequestContext;
    readonly inviteToken?: string;
  }): Promise<GoogleCompleteResponse> {
    if (!this.isAvailable()) {
      recordGoogleAuth('complete', 'disabled');
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    const now = new Date();
    const flow = input.handoff.startsWith(PENDING_PREFIX)
      ? null
      : await this.repository.claimHandoff(hashFlowSecret(input.handoff), now);
    // One answer for every way a completion can be stale or foreign: an
    // unknown/used/expired handoff, another browser (no or wrong binder),
    // or another origin. Nothing about the flow is disclosed.
    if (
      !flow ||
      !flowSecretMatches(input.binder, flow.binderHash) ||
      !input.origin ||
      input.origin !== flow.originHost ||
      !flow.providerSubject ||
      !flow.providerEmail
    ) {
      recordGoogleAuth('complete', 'invalid_state');
      throw new UnauthorizedException({ messageKey: 'errors.auth.googleSignInExpired' });
    }
    const returnPath = flow.returnPath ?? undefined;

    if (flow.providerEmailVerified !== true) {
      await this.repository.markCompleted(flow.id, now);
      recordGoogleAuth('complete', 'unverified_email');
      throw new ForbiddenException({ messageKey: 'errors.auth.googleEmailUnverified' });
    }

    if (flow.intent === 'link' || flow.intent === 'setup') {
      return this.completeBinding(flow, input.context);
    }

    const identity = await this.repository.findIdentity(flow.providerSubject);
    if (identity) {
      try {
        const response = await this.finishSignIn(identity.user, flow, input.context, {
          join: true,
          inviteToken: input.inviteToken,
        });
        await this.repository.touchIdentity(identity.id, flow.providerEmail, now);
        recordGoogleAuth('complete', 'existing_identity');
        return response;
      } catch (error) {
        recordGoogleAuth(
          'complete',
          error instanceof HttpException && error.getStatus() === 429
            ? 'rate_limited'
            : 'refused',
        );
        throw error;
      } finally {
        await this.repository.markCompleted(flow.id, new Date());
      }
    }

    // Not linked. An address match is a question for the account's owner,
    // never an answer: the owner must prove that account (the next step).
    const existing = await this.usersRepository.findByEmail(flow.providerEmail);
    const authoritative = isGoogleAuthoritative({
      email: flow.providerEmail,
      emailVerified: true,
      hostedDomain: flow.providerHostedDomain,
    });
    const step: GoogleStepContract['googleStep'] = !existing
      ? 'create_account'
      : existing.status === 'invited' && authoritative
        ? 'activate_invited'
        : 'link_required';

    const pending = `${PENDING_PREFIX}${newFlowSecret()}`;
    const expiresAt = new Date(Date.now() + PENDING_TTL_MS);
    await this.repository.reissuePending(flow.id, {
      hash: hashFlowSecret(pending),
      expiresAt,
    });
    recordGoogleAuth('complete', step);
    return {
      googleStep: step,
      pending,
      expiresAt: expiresAt.toISOString(),
      email: flow.providerEmail,
      ...(step === 'create_account' && flow.providerName
        ? { name: flow.providerName }
        : {}),
      ...(returnPath ? { returnPath } : {}),
    };
  }

  // ==================================================================
  // Phase 2 — binding the identity
  // ==================================================================

  /**
   * `link` / `setup` — WHICH account the flow binds to is fixed when it
   * starts: the signed-in session's account, or the setup token's account.
   * Never the body, never the Google address.
   */
  private async bindingUserFor(input: {
    readonly intent: GoogleIntent;
    readonly signedInUserId?: string;
    readonly setupToken?: string;
    readonly currentPassword?: string;
  }): Promise<string | null> {
    if (input.intent === 'link') {
      if (!input.signedInUserId) {
        throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
      }
      // Re-authentication, like disconnecting: a session alone (a stolen
      // short-lived access token, say) must not be able to attach a Google
      // account that would outlive it — a new sign-in method is persistent
      // access. An account without a usable password already has Google
      // (it is the only other way in), and one Google account per account.
      const user = await this.usersRepository.findById(input.signedInUserId);
      if (!user) throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
      if (await this.repository.findIdentityForUser(user.id)) {
        throw new ConflictException({ messageKey: 'errors.auth.googleAlreadyLinked' });
      }
      await this.assertCurrentPassword(user, input.currentPassword ?? '', 'link');
      return user.id;
    }
    if (input.intent === 'setup') {
      const token = input.setupToken
        ? await this.passwordResetTokens.findValidByHash(
            hashOpaqueToken(input.setupToken),
          )
        : null;
      const user = token ? await this.usersRepository.findById(token.userId) : null;
      if (!user || user.status === 'deleted' || user.status === 'suspended') {
        throw new UnauthorizedException({ messageKey: 'errors.auth.invalidResetToken' });
      }
      return user.id;
    }
    return null;
  }

  /**
   * Spends a follow-up step's pending secret — the same browser (binder) on
   * the same origin, within its lifetime. The caller either finishes the
   * flow or, for a fixable failure, releases the secret for another try.
   */
  private async claimStep(
    input: StepRequest,
  ): Promise<AuthOAuthFlow & { providerSubject: string; providerEmail: string }> {
    if (!this.isAvailable())
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    const flow = input.pending.startsWith(PENDING_PREFIX)
      ? await this.repository.claimHandoff(hashFlowSecret(input.pending), new Date())
      : null;
    if (
      !flow ||
      !flowSecretMatches(input.binder, flow.binderHash) ||
      !input.origin ||
      input.origin !== flow.originHost ||
      !flow.providerSubject ||
      !flow.providerEmail ||
      flow.providerEmailVerified !== true
    ) {
      throw new UnauthorizedException({ messageKey: 'errors.auth.googleSignInExpired' });
    }
    return flow as AuthOAuthFlow & { providerSubject: string; providerEmail: string };
  }

  /**
   * The sign-in that follows a successful Google proof: an academy SIGN-UP
   * by an account that already exists joins this academy first (the same
   * write as the password-proven join), then the normal pipeline runs.
   *
   * The academy is the flow's (fixed from the request host when the flow
   * started). For an `invite`-policy academy the invitation code is
   * redeemed by the canonical `claim_academy_invite` against THAT academy
   * and the ACCOUNT's own email, atomically — exactly as `POST
   * /auth/academy-join` redeems it for a password-proven account. Google
   * never bypasses the policy: no code → `inviteRequired`, a bad, foreign,
   * expired, revoked, exhausted or other-address code → `inviteInvalid`. An
   * account that is already a learner here spends nothing and signs in.
   */
  private async finishSignIn(
    user: User,
    flow: AuthOAuthFlow,
    context: SessionRequestContext,
    options: { readonly join: boolean; readonly inviteToken?: string },
  ): Promise<GoogleSignInResponse> {
    try {
      if (
        options.join &&
        flow.surface === 'academy' &&
        flow.intent === 'sign_up' &&
        flow.academyId
      ) {
        await this.authService.joinAcademyAsExistingAccount(user, {
          academyId: flow.academyId,
          hostname: context.hostname,
          inviteToken: options.inviteToken,
        });
      }
      const response = await this.authService.continueSignIn(
        user,
        {
          surface: flow.surface === 'academy' ? 'academy' : 'management',
          academyId: flow.academyId ?? undefined,
        },
        context,
        'google',
      );
      return { ...response, ...(flow.returnPath ? { returnPath: flow.returnPath } : {}) };
    } finally {
      await this.repository.markCompleted(flow.id, new Date());
    }
  }

  /**
   * Writes the identity (and anything the caller adds) in ONE transaction
   * under the account's own context, with the audit entry. The two unique
   * indexes decide every race: this Google account taken → 409
   * `googleIdentityInUse`; this Atlas account already holding another
   * Google account → 409 `googleAlreadyLinked`.
   */
  private async bindIdentity(
    user: User,
    flow: { providerSubject: string; providerEmail: string; academyId: string | null },
    via: 'password' | 'settings' | 'setup' | 'invitation',
    also?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    try {
      await this.tenancyContext.runInUserContext(user.id, async (tx) => {
        await this.repository.createIdentity(tx, {
          userId: user.id,
          subject: flow.providerSubject,
          email: flow.providerEmail,
        });
        if (also) await also(tx);
        await this.auditLog.write(tx, {
          actorUserId: user.id,
          action: 'auth.identity.linked',
          targetType: 'user',
          targetId: user.id,
          ...(flow.academyId ? { academyId: flow.academyId } : {}),
          context: { provider: 'google', via },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const target = String(error.meta?.target ?? '');
        throw new ConflictException({
          messageKey: target.includes('user_id')
            ? 'errors.auth.googleAlreadyLinked'
            : 'errors.auth.googleIdentityInUse',
        });
      }
      throw error;
    }
    await this.notify(user.id, 'auth.identity.linked');
  }

  /** Best-effort security notice after commit — a mail hiccup never undoes the change. */
  private async notify(
    userId: string,
    key: 'auth.identity.linked' | 'auth.identity.unlinked',
  ): Promise<void> {
    try {
      const emitted = await this.tenancyContext.runInUserContext(userId, (tx) =>
        this.communications.emit(tx, {
          key,
          recipientUserId: userId,
          entity: { type: 'user', id: userId },
        }),
      );
      await this.communications.enqueueAfterCommit(emitted.outboxId);
    } catch (error) {
      this.logger.warn(
        { userId, key, error: error instanceof Error ? error.message : String(error) },
        'Could not send the Google sign-in notice; the change itself was made.',
      );
    }
  }

  /** The conflicts every binding path checks before writing. */
  private async assertBindable(
    user: User,
    subject: string,
    stage: 'link' | 'activate' | 'complete',
  ): Promise<'bind' | 'already_bound'> {
    const owner = await this.repository.findIdentity(subject);
    if (owner && owner.userId !== user.id) {
      recordGoogleAuth(stage, 'conflict');
      throw new ConflictException({ messageKey: 'errors.auth.googleIdentityInUse' });
    }
    if (owner) return 'already_bound';
    const current = await this.repository.findIdentityForUser(user.id);
    if (current) {
      recordGoogleAuth(stage, 'conflict');
      throw new ConflictException({ messageKey: 'errors.auth.googleAlreadyLinked' });
    }
    return 'bind';
  }

  /**
   * `POST /auth/google/link` — the `link_required` step: the owner of the
   * EXISTING account with this address proves it with its password (same
   * per-account sign-in budget, same generic 401), then Google is connected
   * and the sign-in continues (TOTP / A6 code as usual). A Platform Owner
   * connects Google only from signed-in Account settings.
   */
  async linkWithPassword(
    input: StepRequest & { readonly password: string },
  ): Promise<GoogleSignInResponse> {
    const flow = await this.claimStep(input);
    const user = await this.usersRepository.findByEmail(flow.providerEmail);
    if (!user) {
      await this.repository.markCompleted(flow.id, new Date());
      throw new UnauthorizedException({ messageKey: 'errors.auth.googleSignInExpired' });
    }

    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const budget = await this.rateLimiter.consume(
      `signin:account:${user.email}`,
      identity.signInRateLimit.max,
      identity.signInRateLimit.windowSeconds,
    );
    if (!budget.allowed) {
      await this.repository.releaseHandoff(flow.id);
      recordGoogleAuth('link', 'rate_limited');
      throw new HttpException(
        { messageKey: 'errors.auth.rateLimited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const valid = await this.passwordHasher.verify(user.passwordHash, input.password);
    if (!valid || user.status === 'deleted' || user.status === 'invited') {
      await this.repository.releaseHandoff(flow.id);
      recordGoogleAuth('link', 'invalid_credentials');
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidCredentials' });
    }
    // Revealed only to someone who proved the password — as sign-in does.
    if (user.status === 'suspended') {
      await this.repository.markCompleted(flow.id, new Date());
      recordGoogleAuth('link', 'refused');
      throw new ForbiddenException({ messageKey: 'errors.auth.accountSuspended' });
    }
    if (user.isPlatformOwner) {
      await this.repository.markCompleted(flow.id, new Date());
      recordGoogleAuth('link', 'refused');
      throw new ForbiddenException({ messageKey: 'errors.auth.googleLinkFromSettings' });
    }

    try {
      if ((await this.assertBindable(user, flow.providerSubject, 'link')) === 'bind') {
        await this.bindIdentity(user, flow, 'password');
      }
    } catch (error) {
      await this.repository.markCompleted(flow.id, new Date());
      throw error;
    }
    recordGoogleAuth('link', 'linked');
    return this.finishSignIn(user, flow, input.context, {
      join: true,
      inviteToken: input.inviteToken,
    });
  }

  /**
   * `POST /auth/google/create-account` — the `create_account` step: ONE new
   * global account with this Google identity, created exactly like a password
   * signup (academy learner row under the registration policy, or the
   * organization bundle on the management surface), then the normal sign-in.
   * The address is verified only if Google is authoritative for it.
   */
  async createAccount(
    input: StepRequest & {
      readonly name: string;
      readonly organizationName?: string;
      readonly planId?: string;
      readonly inviteToken?: string;
      readonly clientContext?: {
        readonly ipAddress?: string;
        readonly userAgent?: string;
      };
    },
  ): Promise<GoogleSignInResponse> {
    const flow = await this.claimStep(input);
    if (await this.repository.findIdentity(flow.providerSubject)) {
      await this.repository.markCompleted(flow.id, new Date());
      recordGoogleAuth('create', 'conflict');
      throw new ConflictException({ messageKey: 'errors.auth.googleIdentityInUse' });
    }
    let user: User;
    try {
      user = await this.authService.registerWithExternalIdentity({
        name: input.name.trim(),
        email: flow.providerEmail,
        academyId: flow.academyId ?? undefined,
        inviteToken: input.inviteToken,
        hostname: input.context.hostname,
        organizationName: input.organizationName,
        planId: input.planId,
        context: input.clientContext,
        external: {
          provider: 'google',
          subject: flow.providerSubject,
          emailVerified: isGoogleAuthoritative({
            email: flow.providerEmail,
            emailVerified: true,
            hostedDomain: flow.providerHostedDomain,
          }),
        },
      });
    } catch (error) {
      // A fixable input (organization name, plan, invite code) keeps the
      // step open; anything else ends the flow.
      const fixable =
        error instanceof BadRequestException ||
        (error instanceof ForbiddenException &&
          (error.getResponse() as { messageKey?: string }).messageKey ===
            'errors.auth.inviteRequired');
      if (fixable) {
        await this.repository.releaseHandoff(flow.id);
      } else {
        await this.repository.markCompleted(flow.id, new Date());
        if (error instanceof ConflictException) recordGoogleAuth('create', 'conflict');
      }
      throw error;
    }
    recordGoogleAuth('create', 'created');
    return this.finishSignIn(user, flow, input.context, { join: false });
  }

  /**
   * `POST /auth/google/activate` — the `activate_invited` step: an account
   * somebody created for this address (Smart Member invitation) is
   * activated by Google instead of the setup link. Allowed only where Google
   * is AUTHORITATIVE for the address, which is the same proof of the mailbox
   * the setup link gives. No password is set; outstanding setup links die.
   */
  async activateInvited(input: StepRequest): Promise<GoogleSignInResponse> {
    const flow = await this.claimStep(input);
    const user = await this.usersRepository.findByEmail(flow.providerEmail);
    const authoritative = isGoogleAuthoritative({
      email: flow.providerEmail,
      emailVerified: true,
      hostedDomain: flow.providerHostedDomain,
    });
    if (!user || user.status !== 'invited' || !authoritative) {
      await this.repository.markCompleted(flow.id, new Date());
      throw new UnauthorizedException({ messageKey: 'errors.auth.googleSignInExpired' });
    }
    try {
      if (
        (await this.assertBindable(user, flow.providerSubject, 'activate')) === 'bind'
      ) {
        await this.bindIdentity(user, flow, 'invitation', (tx) =>
          this.activateInTransaction(tx, user.id),
        );
      }
    } catch (error) {
      await this.repository.markCompleted(flow.id, new Date());
      throw error;
    }
    recordGoogleAuth('activate', 'activated');
    const activated = await this.usersRepository.findById(user.id);
    return this.finishSignIn(activated ?? user, flow, input.context, {
      join: true,
      inviteToken: input.inviteToken,
    });
  }

  /**
   * An invited account becomes active with Google as its sign-in: verified,
   * no password (the unknown invitation hash is replaced by the no-password
   * sentinel so the account honestly reports "no password"), and every
   * outstanding setup/reset link is spent.
   */
  private async activateInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const now = new Date();
    await tx.user.updateMany({
      where: { id: userId, status: 'invited' },
      data: {
        status: 'active',
        emailVerifiedAt: now,
        passwordHash: `${NO_PASSWORD_PREFIX}${hashFlowSecret(newFlowSecret())}`,
      },
    });
    await tx.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    });
  }

  /**
   * `link` (Account settings) and `setup` (the invitation page) — the account
   * was fixed when the flow started. `link` returns without minting a
   * session (the person is already signed in); `setup` activates the account
   * like the setup link would and continues into the sign-in.
   */
  private async completeBinding(
    flow: AuthOAuthFlow,
    context: SessionRequestContext,
  ): Promise<GoogleLinkedContract | GoogleSignInResponse> {
    const subject = flow.providerSubject as string;
    const email = flow.providerEmail as string;
    const user = flow.linkUserId
      ? await this.usersRepository.findById(flow.linkUserId)
      : null;
    if (!user || user.status === 'deleted' || user.status === 'suspended') {
      await this.repository.markCompleted(flow.id, new Date());
      throw new UnauthorizedException({ messageKey: 'errors.auth.googleSignInExpired' });
    }

    if (flow.intent === 'link') {
      try {
        if ((await this.assertBindable(user, subject, 'complete')) === 'bind') {
          await this.bindIdentity(
            user,
            { providerSubject: subject, providerEmail: email, academyId: flow.academyId },
            'settings',
          );
        }
      } finally {
        await this.repository.markCompleted(flow.id, new Date());
      }
      recordGoogleAuth('complete', 'linked');
      return {
        linked: true,
        email,
        ...(flow.returnPath ? { returnPath: flow.returnPath } : {}),
      };
    }

    // setup: the token must still be live — it is what proves the mailbox.
    const live = await this.tenancyContext.runInUserContext(user.id, (tx) =>
      tx.passwordResetToken.count({
        where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      }),
    );
    if (live === 0) {
      await this.repository.markCompleted(flow.id, new Date());
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidResetToken' });
    }
    try {
      if ((await this.assertBindable(user, subject, 'complete')) === 'bind') {
        await this.bindIdentity(
          user,
          { providerSubject: subject, providerEmail: email, academyId: flow.academyId },
          'setup',
          (tx) => this.activateInTransaction(tx, user.id),
        );
      }
    } catch (error) {
      await this.repository.markCompleted(flow.id, new Date());
      throw error;
    }
    recordGoogleAuth('complete', 'activated');
    const activated = (await this.usersRepository.findById(user.id)) ?? user;
    return this.finishSignIn(activated, flow, context, { join: false });
  }

  // ==================================================================
  // Account settings
  // ==================================================================

  /** Settings re-authentication: the account's own password, on its sign-in budget. */
  private async assertCurrentPassword(
    user: User,
    currentPassword: string,
    stage: 'unlink' | 'link',
  ): Promise<void> {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const budget = await this.rateLimiter.consume(
      `signin:account:${user.email}`,
      identity.signInRateLimit.max,
      identity.signInRateLimit.windowSeconds,
    );
    if (!budget.allowed) {
      recordGoogleAuth(stage, 'rate_limited');
      throw new HttpException(
        { messageKey: 'errors.auth.rateLimited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!(await this.passwordHasher.verify(user.passwordHash, currentPassword))) {
      recordGoogleAuth(stage, 'invalid_credentials');
      throw new UnauthorizedException({
        messageKey: 'errors.auth.invalidCurrentPassword',
      });
    }
  }

  async signInMethods(userId: string): Promise<SignInMethodsContract> {
    const user = await this.usersRepository.findById(userId);
    if (!user) throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    const identity = await this.repository.findIdentityForUser(userId);
    return {
      password: hasUsablePassword(user),
      google: identity
        ? { email: identity.emailAtLink, linkedAt: identity.linkedAt.toISOString() }
        : null,
    };
  }

  /**
   * Disconnect Google. Only an account that can still sign in with a
   * password may do it (otherwise it would lock itself out — set a password
   * through "Forgot password" first), and the password is re-entered.
   */
  async unlink(userId: string, currentPassword: string): Promise<void> {
    const user = await this.usersRepository.findById(userId);
    if (!user) throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    if (!(await this.repository.findIdentityForUser(userId))) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    if (!hasUsablePassword(user)) {
      recordGoogleAuth('unlink', 'refused');
      throw new ConflictException({ messageKey: 'errors.auth.setPasswordFirst' });
    }
    await this.assertCurrentPassword(user, currentPassword, 'unlink');
    await this.tenancyContext.runInUserContext(userId, async (tx) => {
      const removed = await this.repository.deleteIdentityForUser(tx, userId);
      if (removed) {
        await this.auditLog.write(tx, {
          actorUserId: userId,
          action: 'auth.identity.unlinked',
          targetType: 'user',
          targetId: userId,
          context: { provider: 'google' },
        });
      }
    });
    recordGoogleAuth('unlink', 'unlinked');
    await this.notify(userId, 'auth.identity.unlinked');
  }
}
