/**
 * AuthService — the full P1 authentication lifecycle (master plan §8,
 * §21 Phase P1). Controllers stay thin; every business rule lives here.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { User } from '@prisma/client';
import type { IdentityConfig } from '../../config/configuration';
import { UsersRepository } from '../repositories/users.repository';
import { RefreshTokensRepository } from '../repositories/refresh-tokens.repository';
import { PasswordResetTokensRepository } from '../repositories/password-reset-tokens.repository';
import { PasswordHasherService } from './password-hasher.service';
import { AccessTokenService } from './access-token.service';
import { generateOpaqueToken, hashOpaqueToken } from '../utils/opaque-token.util';
import { normalizeEmail } from '../utils/email.util';
import { toCurrentUser } from '../dto/contracts';
import type {
  AuthenticationResponseContract,
  TokenRefreshResponseContract,
} from '../dto/contracts';
import { PasswordResetEmailProducer } from '../queue/password-reset-email.producer';
import { UserOrganizationsService } from '../../tenancy/services/user-organizations.service';

/** A value nobody can ever sign in with — see `getDummyHash()`. */
const DUMMY_PASSWORD = 'atlas-p1-dummy-password-for-timing-safety-only';

@Injectable()
export class AuthService {
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
  ) {}

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

    const passwordHash = await this.passwordHasher.hash(input.password);
    await this.usersRepository.create({ email, passwordHash, name: input.name });
  }

  async signIn(input: {
    email: string;
    password: string;
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

    // Suspension is only ever revealed to someone who already proved they
    // know the correct password — no enumeration signal added.
    if (user.status === 'suspended') {
      throw new ForbiddenException({ messageKey: 'errors.auth.accountSuspended' });
    }

    const session = await this.issueSession(user);
    await this.usersRepository.touchLastSignInAt(user.id);

    return session;
  }

  /**
   * Atomically rotates a refresh token — see
   * `RefreshTokensRepository.rotate`'s doc comment for the concurrency
   * guarantee this relies on.
   */
  async refresh(rawRefreshToken: string): Promise<TokenRefreshResponseContract> {
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
    });

    if (!result) {
      // Covers: unknown token, already-revoked token (including a replay
      // of a token a concurrent request just rotated), and expired token —
      // all collapse to the same generic 401, never distinguishing which,
      // so a caller can't probe for which failure mode applies.
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidRefreshToken' });
    }

    const accessToken = this.accessTokenService.issue({
      sub: result.created.userId,
      sid: result.created.id,
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
  async signOut(userId: string, sessionId: string): Promise<void> {
    await this.refreshTokensRepository.revokeByIdForUser(sessionId, userId);
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
  }

  private async issueSession(user: User): Promise<AuthenticationResponseContract> {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const rawRefreshToken = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(rawRefreshToken);
    const expiresAt = new Date(
      Date.now() + identity.refreshTokenTtlDays * 24 * 60 * 60 * 1000,
    );

    const refreshToken = await this.refreshTokensRepository.create({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    const accessToken = this.accessTokenService.issue({
      sub: user.id,
      sid: refreshToken.id,
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
