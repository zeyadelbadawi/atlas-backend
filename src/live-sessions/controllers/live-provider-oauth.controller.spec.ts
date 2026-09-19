/**
 * Who may connect an academy's Zoom account — and, mostly, who may not.
 *
 * This is the rule the previous implementation got wrong. Connecting was
 * gated on `academy.configure`, which a MANAGER holds, so a manager could
 * bind (or rebind) the academy's Zoom account. Connecting activates Live
 * Sessions for the whole academy and attaches a customer's Zoom account,
 * which puts it in the owner-exclusive tier beside billing and add-on
 * lifecycle.
 *
 * The frontend hides the control. That is not the boundary — this is.
 * Every test here calls the controller the way a curl would, with no
 * frontend involved at all.
 */
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { LiveProviderOAuthController } from './live-provider-oauth.controller';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { LiveProviderConnectionService } from '../services/live-provider-connection.service';
import { ZoomOAuthService } from '../services/zoom-oauth.service';
import { CompleteZoomAuthorizationDto } from '../dto/zoom-oauth.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

const ACADEMY_ID = 'academy-1';
const ORG_ID = 'org-1';
const USER_ID = 'user-1';

/** The owner-exclusive string. No `tenant.*` permission appears in the manager set. */
const OWNER = 'tenant.addon.view';

/** Exactly what a Manager carries — note `academy.configure` among them. */
const MANAGER_PERMISSIONS = [
  'academy.view',
  'academy.configure',
  'academy.branding.update',
  'course.manage',
];
const INSTRUCTOR_PERMISSIONS = ['instructor.dashboard.view', 'quiz.manage'];
const STAFF_PERMISSIONS = ['academy.view'];

describe('LiveProviderOAuthController', () => {
  let controller: LiveProviderOAuthController;
  let createAuthorization: jest.Mock;
  let consumeState: jest.Mock;
  let completeOAuthConnection: jest.Mock;

  beforeEach(async () => {
    createAuthorization = jest.fn().mockResolvedValue({
      authorizationUrl: 'https://zoom.us/oauth/authorize?client_id=x&state=y',
      expiresAt: new Date('2026-10-01T10:00:00Z'),
    });
    consumeState = jest
      .fn()
      .mockResolvedValue({ academyId: ACADEMY_ID, organizationId: ORG_ID });
    completeOAuthConnection = jest.fn().mockResolvedValue({ status: 'connected' });

    const moduleRef = await Test.createTestingModule({
      controllers: [LiveProviderOAuthController],
      providers: [
        {
          provide: ZoomOAuthService,
          useValue: { createAuthorization, consumeState },
        },
        {
          provide: LiveProviderConnectionService,
          useValue: { completeOAuthConnection },
        },
      ],
    })
      /*
       * The guards are stubbed because they are NOT what this file tests.
       * `JwtAuthGuard` proves identity and `AcademyScopeGuard` establishes
       * the tenant; both are covered by their own suites. What is under
       * test is the check that runs AFTER them — the owner-only rule,
       * which is the one that was previously wrong.
       */
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      // P64 Phase 1 — management controllers also carry
      // `ManagementSurfaceGuard` (a learner principal is refused).
      .overrideGuard(ManagementSurfaceGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AcademyScopeGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(LiveProviderOAuthController);
  });

  const requestWith = (permissions: readonly string[]): Request =>
    ({
      academyContext: {
        academyId: ACADEMY_ID,
        organizationId: ORG_ID,
        organizationPermissions: permissions,
      },
      authContext: { userId: USER_ID },
    }) as unknown as Request;

  describe('authorize — owner only', () => {
    it('lets an Organization Owner start the authorization', async () => {
      const result = await controller.authorize(
        requestWith([OWNER, ...MANAGER_PERMISSIONS]),
      );

      expect(result.authorizationUrl).toContain('zoom.us/oauth/authorize');
      expect(createAuthorization).toHaveBeenCalledTimes(1);
    });

    /*
     * THE REGRESSION THIS PINS. A Manager holds `academy.configure`, which
     * is what used to gate this endpoint. They must now be refused.
     */
    it('REFUSES a Manager, even though they hold academy.configure', async () => {
      await expect(
        controller.authorize(requestWith(MANAGER_PERMISSIONS)),
      ).rejects.toMatchObject({ status: 403 });
      expect(createAuthorization).not.toHaveBeenCalled();
    });

    it('REFUSES an Instructor', async () => {
      await expect(
        controller.authorize(requestWith(INSTRUCTOR_PERMISSIONS)),
      ).rejects.toMatchObject({ status: 403 });
      expect(createAuthorization).not.toHaveBeenCalled();
    });

    it('REFUSES Staff', async () => {
      await expect(
        controller.authorize(requestWith(STAFF_PERMISSIONS)),
      ).rejects.toMatchObject({ status: 403 });
      expect(createAuthorization).not.toHaveBeenCalled();
    });

    it('REFUSES a caller with no permissions at all', async () => {
      await expect(controller.authorize(requestWith([]))).rejects.toMatchObject({
        status: 403,
      });
    });

    /*
     * THE ACADEMY IS NEVER TAKEN FROM THE BROWSER. It comes from the
     * authenticated academy context the guard established, so a caller
     * cannot start an authorization for a tenant they do not hold.
     */
    it('uses the AUTHENTICATED academy and user, never request input', async () => {
      await controller.authorize(requestWith([OWNER]));
      expect(createAuthorization).toHaveBeenCalledWith({
        academyId: ACADEMY_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
      });
    });

    /* The authorization URL is the only thing returned — never a secret. */
    it('returns no secret material', async () => {
      const result = await controller.authorize(requestWith([OWNER]));
      const serialized = JSON.stringify(result);

      expect(serialized).not.toMatch(/client_secret|clientSecret|refresh|access_token/i);
    });
  });

  describe('callback', () => {
    /*
     * WHY THIS IS AN ORDINARY AUTHENTICATED CALL AND NOT ZOOM'S REDIRECT.
     * Atlas authenticates with a bearer token the SPA holds; Zoom returns
     * the customer as a top-level navigation, which carries no
     * `Authorization` header. Zoom therefore lands on the Atlas page, and
     * the page forwards these values here with the session attached — so
     * every test below supplies an authenticated request, exactly as the
     * running system does.
     */
    const callbackRequest = (): Request =>
      ({ authContext: { userId: USER_ID } }) as unknown as Request;

    const body = (
      code = 'auth-code',
      state = 'state-value',
    ): CompleteZoomAuthorizationDto => ({ code, state });

    it('completes the connection and reports it connected', async () => {
      const result = await controller.callback(callbackRequest(), body());

      expect(completeOAuthConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          academyId: ACADEMY_ID,
          organizationId: ORG_ID,
          code: 'auth-code',
        }),
      );
      expect(result).toEqual({ status: 'connected' });
    });

    /*
     * THE ACADEMY COMES FROM THE STATE ROW, NEVER FROM THE CALLER. There
     * is no academy id in this request at all, which is what stops a
     * Manager reaching another academy's connection through this endpoint.
     */
    it('takes the academy from the stored state, not from the request', async () => {
      consumeState.mockResolvedValue({
        academyId: 'academy-from-state',
        organizationId: 'org-from-state',
      });

      await controller.callback(callbackRequest(), body());

      expect(completeOAuthConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          academyId: 'academy-from-state',
          organizationId: 'org-from-state',
        }),
      );
    });

    /*
     * STATE IS SPENT BEFORE THE CODE IS EXCHANGED, so a forged or
     * replayed callback never reaches Zoom's token endpoint at all.
     */
    it('REJECTS an invalid state without exchanging the code', async () => {
      consumeState.mockResolvedValue(null);

      await expect(
        controller.callback(callbackRequest(), body('auth-code', 'forged-state')),
      ).rejects.toMatchObject({ status: 400 });

      expect(completeOAuthConnection).not.toHaveBeenCalled();
    });

    it('REJECTS a replayed state (already consumed)', async () => {
      consumeState.mockResolvedValue(null);

      await expect(
        controller.callback(callbackRequest(), body('auth-code', 'used-state')),
      ).rejects.toMatchObject({ status: 400 });

      expect(completeOAuthConnection).not.toHaveBeenCalled();
    });

    /*
     * THE USER BINDING. An authorization begun by one owner cannot be
     * completed by anyone else who obtains the state — which is only
     * enforceable because this endpoint knows who is calling it.
     */
    it('consumes the state as the AUTHENTICATED user', async () => {
      await controller.callback(callbackRequest(), body('code', 'state'));
      expect(consumeState).toHaveBeenCalledWith('state', USER_ID);
    });

    /*
     * CROSS-ACADEMY BINDING. A Zoom account already attached to another
     * academy is refused — webhooks are attributed by account id, so a
     * shared account would make that mapping ambiguous.
     */
    it('reports a Zoom account already bound to another academy', async () => {
      completeOAuthConnection.mockRejectedValue(new Error('ACCOUNT_ALREADY_BOUND'));

      await expect(controller.callback(callbackRequest(), body())).rejects.toMatchObject({
        status: 409,
        response: { messageKey: 'errors.liveSessions.accountAlreadyConnected' },
      });
    });

    /* Zoom's own failure text never reaches the browser. */
    it('reports a generic failure without leaking provider detail', async () => {
      completeOAuthConnection.mockRejectedValue(
        new Error('Zoom token request failed with status 400'),
      );

      const caught = await controller
        .callback(callbackRequest(), body())
        .catch((error: unknown) => error);

      expect(caught).toMatchObject({
        status: 400,
        response: { messageKey: 'errors.liveSessions.authorizationFailed' },
      });
      const serialized = JSON.stringify(caught);
      expect(serialized).not.toMatch(/Zoom token|status 400/i);
    });

    /* NO TOKEN, AND NO CODE, EVER COMES BACK OUT. */
    it('returns no token material and never echoes the code', async () => {
      const result = await controller.callback(callbackRequest(), body());
      const serialized = JSON.stringify(result);

      expect(serialized).not.toMatch(/access_token|refresh|secret|auth-code/i);
    });
  });

  /*
   * The cases that no longer reach the controller at all.
   *
   * A declined consent screen returns `error` and NO code — Zoom's own
   * response, handled on the page, which has nothing to send. Anything
   * missing `code` or `state` is refused by validation before any handler
   * runs, so the controller never has to defend against a half-callback.
   */
  describe('CompleteZoomAuthorizationDto', () => {
    const validateBody = async (value: Record<string, unknown>) =>
      validate(plainToInstance(CompleteZoomAuthorizationDto, value));

    it.each([
      ['no code', { state: 'state-value' }],
      ['no state', { code: 'auth-code' }],
      ['an empty code', { code: '', state: 'state-value' }],
      ['an empty state', { code: 'auth-code', state: '' }],
      ['nothing at all', {}],
    ])('refuses a callback with %s', async (_label, value) => {
      await expect(validateBody(value)).resolves.not.toHaveLength(0);
    });

    it('accepts a complete callback', async () => {
      await expect(
        validateBody({ code: 'auth-code', state: 'state-value' }),
      ).resolves.toHaveLength(0);
    });
  });
});
