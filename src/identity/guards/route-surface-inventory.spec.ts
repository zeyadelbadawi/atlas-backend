/**
 * Launch Stabilization A1 (D1) — route surface inventory.
 *
 * Every authenticated route in the application must be classified, so a
 * new management route cannot quietly become reachable from an
 * academy-website session:
 *
 *   - MANAGEMENT: carries `ManagementSurfaceGuard`, `PlatformOwnerGuard` or
 *     `ManagementSessionGuard` (all refuse any session not minted on the
 *     management surface);
 *   - SELF_OR_LEARNER: listed below, with the reason it is safe for an
 *     academy-website session (the caller's own account, the caller's own
 *     learning, or a public/learner read whose authorization is the
 *     caller's own enrollment/membership plus RLS).
 *
 * A route guarded by `JwtAuthGuard` (or `OptionalJwtAuthGuard`) that is
 * neither fails this test. The fix is to add the management guard, or —
 * only if it genuinely is a self/learner route — to list it here.
 *
 * A11 — and every route with NO session guard at all is listed in
 * `PUBLIC_ROUTES` with the reason it may be reached anonymously, so a newly
 * added unguarded route fails here instead of quietly shipping public.
 * Routes come from the shared inventory fixture, which finds controllers
 * by content: `certificates.controllers.ts` (learner certificates and the
 * public `verify/:code`) used to be skipped by a `*.controller.ts` filter.
 */
import { collectDeclaredRoutes } from '../../common/testing/route-inventory.fixture-spec';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { PlatformOwnerGuard } from './platform-owner.guard';
import { ManagementSessionGuard } from './management-session.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';

/**
 * Routes an academy-website session may reach. Key: `METHOD path` as the
 * controller declares it. Grouped by why they are safe.
 */
const SELF_OR_LEARNER = new Set<string>([
  // --- the caller's own account ------------------------------------------
  'POST auth/sign-out',
  // ATO review F1 — the session is read only to check the link is being
  // opened by its own account; the link works signed in or out.
  'POST auth/verify-email',
  'POST auth/verify-email/resend',
  'GET auth/sessions',
  'DELETE auth/sessions/:id',
  'GET auth/validate',
  'GET auth/trusted-devices',
  'DELETE auth/trusted-devices/:id',
  'DELETE auth/trusted-devices',
  // Smart academy signup: the caller's own other academies, answered only
  // to an academy session on its own host, right after joining it.
  'GET auth/academy-join/summary',
  // Google Identity: starting a flow (public for sign-in; `link` binds the
  // caller's OWN account) and the caller's own sign-in methods.
  'POST auth/google/authorize',
  'GET users/me/sign-in-methods',
  'DELETE users/me/sign-in-methods/google',
  'GET auth/2fa/status',
  'POST auth/2fa/setup',
  'POST auth/2fa/confirm',
  'POST auth/2fa/disable',
  'POST auth/2fa/recovery-codes',
  'GET users/me',
  'PATCH users/me',
  'PATCH users/me/preferences',
  'POST users/me/password',
  'GET users/me/communication-preferences',
  'PATCH users/me/communication-preferences',
  'GET notifications',
  'GET notifications/summary',
  'GET notifications/preferences',
  'PATCH notifications/preferences',
  'PATCH notifications/:id/read',
  'POST notifications/read-all',
  // --- the caller's own learning (host-, enrollment- and RLS-bound) -------
  'GET learning/overview',
  'GET learning/quizzes',
  'GET learning/assignments',
  'GET learning/devices',
  'DELETE learning/devices/:deviceId',
  'POST learning/session/takeover',
  'GET learning/results',
  // The caller's own certificates (RLS: the learner's own rows only).
  'GET learning/certificates',
  'GET learning/certificates/:certificateId',
  'GET learning/certificates/:certificateId/download',
  'GET learning/courses/:courseId/completion',
  'GET learning/courses/:id/lessons/:lessonId/content',
  'POST learning/courses/:id/lessons/:lessonId/playback/refresh',
  'GET learning/courses/:id/sequence',
  'POST learning/courses/:id/playback',
  'POST learning/courses/:id/playback/release',
  'DELETE learning/courses/:id/progress/complete-lesson/:lessonId',
  'GET enrollments',
  'GET enrollments/by-course/:courseId',
  'POST enrollments',
  'GET courses',
  'GET courses/:id',
  'GET courses/:id/sections',
  'GET courses/:id/progress',
  'POST courses/:id/progress/complete-lesson',
  'GET courses/:id/quizzes',
  'GET courses/:id/quizzes/:quizId',
  'GET courses/:id/quizzes/:quizId/attempts',
  'POST courses/:id/quizzes/:quizId/attempts',
  'GET courses/:id/quizzes/:quizId/attempts/:attemptId',
  'PUT courses/:id/quizzes/:quizId/attempts/:attemptId/answers',
  'POST courses/:id/quizzes/:quizId/attempts/:attemptId/submit',
  'POST courses/:id/quizzes/:quizId/attempts/:attemptId/events',
  'GET courses/:id/quizzes/:quizId/attempts/:attemptId/results',
  'GET courses/:id/assignments',
  'GET courses/:id/assignments/:assignmentId',
  'GET courses/:id/assignments/:assignmentId/submission',
  'POST courses/:id/assignments/:assignmentId/submission',
  'PUT courses/:id/assignments/:assignmentId/submission/draft',
  'POST courses/:id/assignments/:assignmentId/submission/attachment',
  'GET courses/:id/reviews/mine',
  'POST courses/:id/reviews',
  'PATCH courses/:id/reviews/mine',
  'DELETE courses/:id/reviews/mine',
  // --- community reads and learner participation (authoring/moderation are
  //     management-guarded) --------------------------------------------------
  'GET announcements',
  'GET announcements/:id',
  'GET courses/:courseId/announcements',
  'GET academies/:academyId/announcements',
  'GET courses/:id/forum',
  'GET courses/:id/forum/threads',
  'GET courses/:id/forum/threads/:threadId',
  'GET courses/:id/forum/threads/:threadId/replies',
  'POST courses/:id/forum/threads',
  'POST courses/:id/forum/threads/:threadId/replies',
  // --- the caller's own purchases -------------------------------------------
  'POST courses/:id/course-orders',
  'GET course-orders',
  'GET course-orders/:orderId',
  'GET course-orders/:id/payment-methods',
  'POST course-orders/:id/payments',
  'GET course-orders/:id/payments/:paymentId',
  'PATCH course-orders/:id/payments/:paymentId/proof',
  'GET course-orders/:id/payments/:paymentId/proof/file',
  'POST course-orders/:id/refund',
  'GET course-orders/:id/refund',
  // Academy Manual Payments — "My payments", scoped to app.current_user_id.
  'GET course-payments',
  // --- live sessions a learner joins ----------------------------------------
  'GET live-sessions/courses/:courseId',
  'GET live-sessions/:liveSessionId/eligibility',
  'POST live-sessions/:liveSessionId/join',
  'POST live-sessions/:liveSessionId/join/redeem',
]);

/**
 * A11 — every route reachable with NO session, and why that is safe. Each
 * one authenticates some other way (a signature, a secret, a token in the
 * request), is rate-limited pre-authentication, or serves only what is
 * public by design.
 */
const PUBLIC_ROUTES: Readonly<Record<string, string>> = {
  // --- credential exchange (rate-limited; the credential IS the auth) -----
  'POST auth/sign-in': 'password sign-in; SignInRateLimitGuard',
  'POST auth/register': 'account creation; RegisterRateLimitGuard',
  'POST auth/refresh': 'rotates the HttpOnly refresh cookie it is sent',
  'POST auth/academy-join': 'sign-in/up on an academy host; SignInRateLimitGuard',
  'POST auth/2fa/verify': 'completes a sealed second-factor challenge; rate-limited',
  'POST auth/otp/verify': 'completes a sealed email-OTP challenge; rate-limited',
  'POST auth/otp/resend': 'resends for a sealed challenge; rate-limited',
  'POST auth/password-reset/request': 'uniform response for any email; rate-limited',
  'POST auth/password-reset/validate': 'checks a single-use reset token; rate-limited',
  'POST auth/password-reset/confirm': 'consumes a single-use reset token; rate-limited',
  'GET auth/options': 'which sign-in methods this host offers (no account data)',
  'GET auth/google/callback': "Google's redirect; state + PKCE + binder cookie",
  'POST auth/google/complete': 'redeems a one-time handoff bound to the binder cookie',
  'POST auth/google/activate': 'redeems a one-time handoff; rate-limited',
  'POST auth/google/create-account': 'redeems a one-time handoff; rate-limited',
  'POST auth/google/link': 'links after a password re-check; rate-limited',
  // --- signed provider webhooks (verified over the raw bytes) -------------
  'POST webhooks/email/:provider':
    'Svix signature (Resend) / URL secret (Brevo), replay-claimed',
  'POST webhooks/video/stream': 'Cloudflare Stream HMAC signature',
  'POST live-sessions/webhook': 'Zoom x-zm-signature',
  'POST live-sessions/deauthorization': 'Zoom x-zm-signature',
  'POST payments/webhook': 'payment provider HMAC signature',
  // --- public website runtime and media (public by design) ----------------
  'GET public/websites/resolve': 'hostname -> academy, published state only',
  'GET public/websites/:academyId': 'published website only',
  'GET public/websites/:academyId/identity': 'published identity only',
  'GET public/websites/:academyId/pages': 'published pages only',
  'GET public/websites/:academyId/pages/:slug': 'published page only',
  'GET public/websites/:academyId/categories': 'public catalog',
  'GET public/websites/:academyId/courses': 'public, published courses only',
  'GET public/websites/:academyId/courses/:courseId': 'public, published course only',
  'GET public/websites/:academyId/courses/:courseId/curriculum':
    'titles of a public course; no lesson content',
  'GET public/websites/:academyId/courses/:courseId/rating': 'aggregate only',
  'GET public/websites/:academyId/courses/:courseId/reviews': 'approved reviews only',
  'GET public/websites/:academyId/courses/:courseId/recommendations':
    'public courses only',
  'GET public/websites/:academyId/statistics': 'aggregate public counts',
  'GET public/websites/:academyId/favicon':
    'inline bytes or own-media redirect only (W2)',
  'GET public/websites/:academyId/logo': 'bounded PNG of the academy logo for emails',
  'POST public/websites/:academyId/contact': 'visitor contact form; rate-limited',
  'GET public/media/academies/:academyId/:fileName':
    'published/public-tier assets, or a signed link (W1)',
  'GET public/plans': 'public price list',
  'GET public/signup-options': 'which signup paths are enabled',
  'POST public/contact': 'marketing contact form; rate-limited',
  'GET verify/:code': 'public certificate verification by unguessable code',
  // --- links from emails (the token is the authorization) -----------------
  'GET communications/unsubscribe': 'shows the signed unsubscribe token',
  'POST communications/unsubscribe': 'applies the signed unsubscribe token',
  // --- telemetry and infrastructure ---------------------------------------
  'POST security/csp-reports': 'browser CSP reports; small bodies, rate-limited',
  'POST rum/vitals': 'browser web-vitals beacons; small bodies, rate-limited',
  'GET health': 'liveness for the orchestrator; no data',
  'GET metrics': 'MetricsAccessGuard (scrape token)',
};

function isAuthenticated(guards: readonly unknown[]): boolean {
  return guards.some((g) => g === JwtAuthGuard || g === OptionalJwtAuthGuard);
}

function isManagement(guards: readonly unknown[]): boolean {
  return guards.some(
    (g) =>
      g === ManagementSurfaceGuard ||
      g === PlatformOwnerGuard ||
      g === ManagementSessionGuard,
  );
}

describe('Launch Stabilization A1 — route surface inventory', () => {
  const routes = collectDeclaredRoutes().map((r) => ({
    key: r.key,
    file: r.file,
    authenticated: isAuthenticated(r.guards),
    management: isManagement(r.guards),
  }));

  it('found the application routes', () => {
    expect(routes.length).toBeGreaterThan(200);
  });

  it('classifies every authenticated route as management-guarded or self/learner', () => {
    const unclassified = routes
      .filter((r) => r.authenticated && !r.management && !SELF_OR_LEARNER.has(r.key))
      .map((r) => `${r.key}  (${r.file})`);
    expect(unclassified).toEqual([]);
  });

  // TASK 7 — the marketing contact form is public (no session to classify);
  // its inbox is Platform-Owner only and must never be reachable from an
  // academy-website session, so it must never land in SELF_OR_LEARNER.
  it('keeps the platform contact inbox management-guarded and its public form unauthenticated', () => {
    const inbox = routes.filter((r) => r.key.includes('platform/contact-submissions'));
    expect(inbox.map((r) => r.key).sort()).toEqual([
      'DELETE platform/contact-submissions/:id',
      'GET platform/contact-submissions',
      'GET platform/contact-submissions/:id',
      'GET platform/contact-submissions/summary',
      'PATCH platform/contact-submissions/:id',
    ]);
    expect(inbox.every((r) => r.authenticated && r.management)).toBe(true);
    expect(inbox.some((r) => SELF_OR_LEARNER.has(r.key))).toBe(false);

    const form = routes.find((r) => r.key === 'POST public/contact');
    expect(form).toMatchObject({ authenticated: false, management: false });
  });

  // A11 — no route may be anonymous by omission.
  it('lists every unauthenticated route explicitly, with a reason', () => {
    const unlisted = routes
      .filter((r) => !r.authenticated && !(r.key in PUBLIC_ROUTES))
      .map((r) => `${r.key}  (${r.file})`);
    expect(unlisted).toEqual([]);
  });

  it('keeps the public allow-list exact: every entry exists and is really unauthenticated', () => {
    const publicNow = new Set(routes.filter((r) => !r.authenticated).map((r) => r.key));
    expect(Object.keys(PUBLIC_ROUTES).filter((key) => !publicNow.has(key))).toEqual([]);
  });

  it('keeps the self/learner allow-list free of stale entries', () => {
    const live = new Set(routes.filter((r) => r.authenticated).map((r) => r.key));
    const stale = [...SELF_OR_LEARNER].filter((key) => !live.has(key));
    expect(stale).toEqual([]);
  });
});
