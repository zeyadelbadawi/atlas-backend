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
 */
import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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
  // --- live sessions a learner joins ----------------------------------------
  'GET live-sessions/courses/:courseId',
  'GET live-sessions/:liveSessionId/eligibility',
  'POST live-sessions/:liveSessionId/join',
  'POST live-sessions/:liveSessionId/join/redeem',
]);

type Guard = abstract new (...args: never[]) => unknown;

function listControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listControllerFiles(full));
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function guardsOf(target: object): Guard[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as Guard[] | undefined) ?? [];
}

function paths(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value ?? ''];
  return list.map((p) => String(p).replace(/^\/+|\/+$/g, ''));
}

interface RouteInfo {
  readonly key: string;
  readonly file: string;
  readonly authenticated: boolean;
  readonly management: boolean;
}

function collectRoutes(): RouteInfo[] {
  const root = join(__dirname, '..', '..');
  const routes: RouteInfo[] = [];
  for (const file of listControllerFiles(root)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const controllerPaths = Reflect.getMetadata(PATH_METADATA, exported) as unknown;
      if (controllerPaths === undefined) continue;
      const classGuards = guardsOf(exported);
      const proto = (exported as { prototype: object }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = (proto as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        if (method === undefined) continue;
        const guards = [...classGuards, ...guardsOf(handler)];
        const authenticated = guards.some(
          (g) => g === JwtAuthGuard || g === OptionalJwtAuthGuard,
        );
        const management = guards.some(
          (g) =>
            g === ManagementSurfaceGuard ||
            g === PlatformOwnerGuard ||
            g === ManagementSessionGuard,
        );
        const methodPaths = paths(Reflect.getMetadata(PATH_METADATA, handler));
        for (const base of paths(controllerPaths)) {
          for (const sub of methodPaths) {
            const path = [base, sub].filter(Boolean).join('/');
            routes.push({
              key: `${RequestMethod[method]} ${path}`,
              file: relative(root, file),
              authenticated,
              management,
            });
          }
        }
      }
    }
  }
  return routes;
}

describe('Launch Stabilization A1 — route surface inventory', () => {
  const routes = collectRoutes();

  it('found the application routes', () => {
    expect(routes.length).toBeGreaterThan(200);
  });

  it('classifies every authenticated route as management-guarded or self/learner', () => {
    const unclassified = routes
      .filter((r) => r.authenticated && !r.management && !SELF_OR_LEARNER.has(r.key))
      .map((r) => `${r.key}  (${r.file})`);
    expect(unclassified).toEqual([]);
  });

  it('keeps the self/learner allow-list free of stale entries', () => {
    const live = new Set(routes.filter((r) => r.authenticated).map((r) => r.key));
    const stale = [...SELF_OR_LEARNER].filter((key) => !live.has(key));
    expect(stale).toEqual([]);
  });
});
