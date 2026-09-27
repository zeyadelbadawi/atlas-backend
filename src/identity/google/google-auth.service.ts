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
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthOAuthFlow } from '@prisma/client';
import type { AppConfig, GoogleAuthConfig } from '../../config/configuration';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { recordGoogleAuth } from '../../observability/metrics/google-auth-metrics';
import type { AuthenticationResponseContract } from '../dto/contracts';
import { UsersRepository } from '../repositories/users.repository';
import { AcademySurfaceService } from '../services/academy-surface.service';
import { AuthService, type SessionRequestContext } from '../services/auth.service';
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

export type GoogleIntent = 'sign_in' | 'sign_up';

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

export type GoogleCompleteResponse =
  | (AuthenticationResponseContract & { readonly returnPath?: string })
  | GoogleStepContract;

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
  ) {}

  private get config(): GoogleAuthConfig {
    return this.configService.getOrThrow<GoogleAuthConfig>('googleAuth');
  }

  private get isProduction(): boolean {
    return this.configService.getOrThrow<AppConfig>('app').nodeEnv === 'production';
  }

  /** Whether Google sign-in is offered for this surface (flag + credentials). */
  isEnabledFor(surface: 'management' | 'academy', academyId?: string | null): boolean {
    const { mode, academyIds } = this.config;
    if (mode === 'off' || !this.oidc.isConfigured()) return false;
    if (mode === 'on') return true;
    return surface === 'academy' && !!academyId && academyIds.includes(academyId);
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
      ipAddress: input.ipAddress ?? null,
      expiresAt,
    });
    recordGoogleAuth('authorize', 'started');

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

    const identity = await this.repository.findIdentity(flow.providerSubject);
    if (identity) {
      try {
        const response = await this.authService.continueSignIn(
          identity.user,
          {
            surface: flow.surface === 'academy' ? 'academy' : 'management',
            academyId: flow.academyId ?? undefined,
          },
          input.context,
          'google',
        );
        await this.repository.touchIdentity(identity.id, flow.providerEmail, now);
        recordGoogleAuth('complete', 'existing_identity');
        return { ...response, ...(returnPath ? { returnPath } : {}) };
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
}
