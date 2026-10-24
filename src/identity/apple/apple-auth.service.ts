/**
 * Sign in with Apple for the Atlas mobile app (B2, docs/mobile/MOBILE_APP_BACKEND.md).
 *
 * Native only: the iOS app shows Apple's sheet and sends the identity token
 * here; there is no browser redirect. Apple is a FIRST FACTOR, exactly like
 * Google (docs/GOOGLE_IDENTITY.md): it replaces the password step and only
 * that step. Everything after it — account status, the academy's surface and
 * registration rules, TOTP, the academy's emailed code — is the existing
 * pipeline (`AuthService.continueSignIn`).
 *
 * Resolution, the same rules as Google:
 *   - `(apple, sub)` linked → that account signs in;
 *   - not linked, an account has the address → `link_required`: the owner
 *     proves it with its password; an address match alone never links;
 *   - not linked, no account → `create_account`: the app collects name,
 *     phone, 13+ and terms, then ONE account is created through the same
 *     registration transaction as a password sign-up.
 *
 * Academy sessions only (the app is the learner app). `FLAG_AUTH_APPLE_MODE`
 * other than `on`, or no `APPLE_CLIENT_IDS` → every route answers 404.
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
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { User } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { RedisService } from '../../redis/redis.service';
import type { IdentityConfig } from '../../config/configuration';
import type { AuthenticationResponseContract } from '../dto/contracts';
import { IdentityResolver } from '../repositories/identity-resolver';
import { UsersRepository } from '../repositories/users.repository';
import { AcademySurfaceService } from '../services/academy-surface.service';
import { AuthRateLimiterService } from '../services/auth-rate-limiter.service';
import { AuthService, type SessionRequestContext } from '../services/auth.service';
import { PasswordCredentialsService } from '../services/password-credentials.service';
import type { ConsentsDto } from '../consents/consents.dto';
import { AppleIdTokenVerifier, AppleTokenError } from './apple-id-token.verifier';
import { ApplePendingStore, type ApplePendingState } from './apple-pending.store';
import { AppleTokenService } from './apple-token.service';

export interface AppleStepContract {
  readonly appleStep: 'link_required' | 'create_account';
  readonly pending: string;
  readonly expiresAt: string;
  /** The address Apple shared (possibly a private relay address). */
  readonly email: string;
  readonly name?: string;
}

export type AppleSignInResponse = AuthenticationResponseContract | AppleStepContract;

@Injectable()
export class AppleAuthService {
  private readonly logger = new Logger(AppleAuthService.name);
  private readonly verifier: AppleIdTokenVerifier;
  private readonly pending: ApplePendingStore;

  constructor(
    private readonly config: ConfigService,
    redis: RedisService,
    private readonly identityResolver: IdentityResolver,
    private readonly usersRepository: UsersRepository,
    private readonly academySurface: AcademySurfaceService,
    private readonly authService: AuthService,
    private readonly tenancy: TenancyContextService,
    private readonly auditLog: AuditLogWriterService,
    private readonly communications: CommunicationService,
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly passwordCredentials: PasswordCredentialsService,
    private readonly appleTokens: AppleTokenService,
  ) {
    this.verifier = new AppleIdTokenVerifier(this.clientIds());
    this.pending = new ApplePendingStore(() => redis.getClient());
  }

  private clientIds(): string[] {
    return (this.config.get<string>('APPLE_CLIENT_IDS') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  }

  /** Whether the app should show the Apple button at all. */
  isAvailable(): boolean {
    return (
      this.config.get<string>('FLAG_AUTH_APPLE_MODE') === 'on' &&
      this.clientIds().length > 0
    );
  }

  private assertAvailable(): void {
    if (!this.isAvailable())
      throw new NotFoundException({ messageKey: 'errors.notFound' });
  }

  async nativeSignIn(input: {
    readonly identityToken: string;
    readonly rawNonce: string;
    readonly authorizationCode?: string;
    readonly givenName?: string;
    readonly familyName?: string;
    readonly academyId: string;
    readonly context: SessionRequestContext;
  }): Promise<AppleSignInResponse> {
    this.assertAvailable();
    await this.academySurface.assertAcademyMatchesHost(
      input.academyId,
      input.context.hostname,
    );

    let claims;
    try {
      claims = await this.verifier.verify(input.identityToken, input.rawNonce);
    } catch (error) {
      if (error instanceof AppleTokenError && error.kind === 'provider_error') {
        throw new ServiceUnavailableException({
          messageKey: 'errors.auth.appleUnavailable',
        });
      }
      throw new UnauthorizedException({ messageKey: 'errors.auth.appleSignInInvalid' });
    }
    const sealed = await this.appleTokens.sealedTokenFor(
      claims.clientId,
      input.authorizationCode,
    );
    const selection = { surface: 'academy' as const, academyId: input.academyId };

    const ownerId = await this.identityResolver.identityOwner('apple', claims.subject);
    if (ownerId) {
      const user = await this.usersRepository.findById(ownerId);
      if (!user)
        throw new UnauthorizedException({ messageKey: 'errors.auth.appleSignInInvalid' });
      await this.appleTokens.storeOwn(user.id, claims.clientId, sealed);
      await this.tenancy.runInUserContext(user.id, (tx) =>
        tx.userAuthIdentity.updateMany({
          where: { userId: user.id, provider: 'apple' },
          data: { lastUsedAt: new Date(), emailAtLink: claims.email },
        }),
      );
      return this.authService.continueSignIn(user, selection, input.context, 'apple');
    }

    const existing = await this.usersRepository.findByEmail(claims.email);
    const name = [input.givenName, input.familyName]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' ');
    const state: ApplePendingState = {
      subject: claims.subject,
      email: claims.email,
      clientId: claims.clientId,
      academyId: input.academyId,
      hostname: input.context.hostname ?? '',
      name: name || null,
      sealedRefreshToken: sealed,
    };
    const { pending, expiresAt } = await this.pending.issue(state);
    return {
      appleStep: existing ? 'link_required' : 'create_account',
      pending,
      expiresAt: expiresAt.toISOString(),
      email: claims.email,
      ...(!existing && state.name ? { name: state.name } : {}),
    };
  }

  /** `link_required` — the existing account's owner proves it with its password. */
  async linkWithPassword(input: {
    readonly pending: string;
    readonly password: string;
    readonly context: SessionRequestContext;
  }): Promise<AuthenticationResponseContract> {
    this.assertAvailable();
    const state = await this.takeStep(input.pending, input.context);
    const user = await this.usersRepository.findByEmail(state.email);
    if (!user)
      throw new UnauthorizedException({ messageKey: 'errors.auth.appleSignInExpired' });

    const identity = this.config.getOrThrow<IdentityConfig>('identity');
    const budget = await this.rateLimiter.consume(
      `signin:account:${user.email}`,
      identity.signInRateLimit.max,
      identity.signInRateLimit.windowSeconds,
    );
    if (!budget.allowed) {
      await this.pending.release(input.pending, state);
      throw new HttpException(
        { messageKey: 'errors.auth.rateLimited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const valid = await this.passwordCredentials.verify(user.id, input.password);
    if (!valid || user.status === 'deleted' || user.status === 'invited') {
      await this.pending.release(input.pending, state);
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidCredentials' });
    }
    if (user.status === 'suspended') {
      throw new ForbiddenException({ messageKey: 'errors.auth.accountSuspended' });
    }
    // Same rule as Google: a Platform Owner never gains a federated sign-in
    // from a sign-in screen.
    if (user.isPlatformOwner) {
      throw new ForbiddenException({ messageKey: 'errors.auth.appleLinkRefused' });
    }

    await this.bind(user, state, 'password');
    await this.notifyLinked(user.id);
    return this.authService.continueSignIn(
      user,
      { surface: 'academy', academyId: state.academyId },
      input.context,
      'apple',
    );
  }

  /** `create_account` — ONE new account with this Apple identity. */
  async createAccount(input: {
    readonly pending: string;
    readonly name: string;
    readonly phoneNumber: string;
    readonly phoneCountry: string;
    readonly consents: ConsentsDto;
    readonly context: SessionRequestContext;
    readonly clientContext?: { readonly ipAddress?: string; readonly userAgent?: string };
  }): Promise<AuthenticationResponseContract> {
    this.assertAvailable();
    const state = await this.takeStep(input.pending, input.context);
    if (await this.identityResolver.identityOwner('apple', state.subject)) {
      throw new ConflictException({ messageKey: 'errors.auth.appleIdentityInUse' });
    }
    let user: User;
    try {
      user = await this.authService.registerWithExternalIdentity({
        name: input.name.trim(),
        email: state.email,
        academyId: state.academyId,
        hostname: input.context.hostname,
        phoneNumber: input.phoneNumber,
        phoneCountry: input.phoneCountry,
        consents: input.consents,
        context: input.clientContext,
        // Apple verifies every address it shares, relay addresses included.
        external: { provider: 'apple', subject: state.subject, emailVerified: true },
      });
    } catch (error) {
      // A fixable input (name, phone number, a number already in use) keeps
      // the step open for another try; anything else ends it.
      const key = (error as HttpException).getResponse?.() as
        { messageKey?: string } | undefined;
      const fixable =
        error instanceof BadRequestException ||
        (error instanceof ConflictException &&
          key?.messageKey === 'errors.auth.phoneTaken');
      if (fixable) await this.pending.release(input.pending, state);
      throw error;
    }
    await this.appleTokens.storeOwn(user.id, state.clientId, state.sealedRefreshToken);
    return this.authService.continueSignIn(
      user,
      { surface: 'academy', academyId: state.academyId },
      input.context,
      'apple',
    );
  }

  /** The step's secret, on the host it was issued for; one answer for every stale case. */
  private async takeStep(
    pending: string,
    context: SessionRequestContext,
  ): Promise<ApplePendingState> {
    const state = await this.pending.take(pending);
    if (!state || state.hostname !== (context.hostname ?? '')) {
      throw new UnauthorizedException({ messageKey: 'errors.auth.appleSignInExpired' });
    }
    return state;
  }

  private async bind(
    user: User,
    state: ApplePendingState,
    via: 'password',
  ): Promise<void> {
    try {
      await this.tenancy.runInUserContext(user.id, async (tx) => {
        await tx.userAuthIdentity.create({
          data: {
            userId: user.id,
            provider: 'apple',
            providerSubject: state.subject,
            emailAtLink: state.email,
            lastUsedAt: new Date(),
          },
        });
        await this.appleTokens.store(
          tx,
          user.id,
          state.clientId,
          state.sealedRefreshToken,
        );
        await this.auditLog.write(tx, {
          actorUserId: user.id,
          action: 'auth.identity.linked',
          targetType: 'user',
          targetId: user.id,
          academyId: state.academyId,
          context: { provider: 'apple', via },
        });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const alreadyLinked = await this.tenancy.runInUserContext(user.id, (tx) =>
          tx.userAuthIdentity.findFirst({
            where: { userId: user.id, provider: 'apple' },
          }),
        );
        throw new ConflictException({
          messageKey: alreadyLinked
            ? 'errors.auth.appleAlreadyLinked'
            : 'errors.auth.appleIdentityInUse',
        });
      }
      throw error;
    }
  }

  /** Best-effort security email after commit; a mail hiccup never undoes the link. */
  private async notifyLinked(userId: string): Promise<void> {
    try {
      const emitted = await this.tenancy.runInUserContext(userId, (tx) =>
        this.communications.emit(tx, {
          key: 'auth.identity.apple_linked',
          recipientUserId: userId,
          entity: { type: 'user', id: userId },
        }),
      );
      await this.communications.enqueueAfterCommit(emitted.outboxId);
    } catch (error) {
      this.logger.warn(
        { userId, error: error instanceof Error ? error.message : String(error) },
        'Could not send the Apple sign-in notice; the link itself was made.',
      );
    }
  }
}
