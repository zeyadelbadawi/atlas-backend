/**
 * EVERY LINK AN EMAIL CARRIES MUST LAND ON A PAGE THAT EXISTS, ON THE HOST
 * IT IS BUILT FOR.
 *
 * The catalogue decides a path; `CommunicationDispatchService.render` turns
 * it into an absolute URL on one of two surfaces — the academy's own host
 * for a `branding: 'academy'` key, the platform web app otherwise. Neither
 * half knows anything about the frontend's router, so both failures below
 * are completely silent here and completely visible to the recipient:
 *
 *  1. A PATH THAT IS NOT A ROUTE. `/dashboard/billing` looks exactly like
 *     a real route and is not one (`/dashboard/tenant/billing` is), so an
 *     owner told "your payment was approved" reached the not-found page.
 *  2. A PATH ON THE WRONG SURFACE. An academy host does not mount the
 *     management dashboard at all — `AppRouter` hands the WHOLE tree to
 *     `PublicWebsiteRouter` there — so a `/dashboard/...` link built on an
 *     academy host falls into the CMS catch-all and renders that academy's
 *     404. This is how four live-session notifications pointed learners at
 *     `/dashboard/learning/courses/:id`, a path P64 Phase 2 retired and
 *     which never existed on an academy host in the first place.
 *
 * SCOPE, STATED HONESTLY — the same bargain `frontend-translation-coverage.spec.ts`
 * strikes, for the same reason. The route registry lives in the sibling
 * repository. When `../atlas-front` is not checked out (a CI job with only
 * this repository) these tests SKIP rather than fail, because a test that
 * fails for being run in the wrong place only teaches people to ignore it.
 * It therefore protects development — where both repositories sit side by
 * side and where the mistake is actually made — and claims nothing about
 * CI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../database/prisma.service';
import {
  COMMUNICATION_CATALOG,
  COMMUNICATION_EVENT_KEYS,
  type CommunicationEventKey,
} from './communication-catalog';
import { LinkBuilderService } from '../services/link-builder.service';

/**
 * The sibling frontend checkout.
 *
 * `ATLAS_FRONTEND_ROOT` overrides it, and exists for one situation this
 * pair of repositories is always in during a cross-cutting change: the
 * backend change sits on a worktree and the matching frontend change sits
 * on a worktree of the OTHER repository, so `../atlas-front` resolves to
 * the other repo's main branch — which of course does not carry the keys
 * yet, and the spec would report a failure that is real for main and
 * meaningless for the branch under test. The default is unchanged, so
 * nothing about an ordinary run moves.
 */
const FRONTEND_ROOT = process.env.ATLAS_FRONTEND_ROOT
  ? resolve(process.env.ATLAS_FRONTEND_ROOT)
  : resolve(__dirname, '../../../../atlas-front');
const ROUTE_PATHS_FILE = resolve(FRONTEND_ROOT, 'src/app/routes/route-paths.ts');
const PUBLIC_ROUTER_FILE = resolve(
  FRONTEND_ROOT,
  'src/features/public-website/PublicWebsiteRouter.tsx',
);
const PAGE_RESOLUTION_FILE = resolve(
  FRONTEND_ROOT,
  'src/features/public-website/utils/page-resolution.utils.ts',
);

const available = [ROUTE_PATHS_FILE, PUBLIC_ROUTER_FILE, PAGE_RESOLUTION_FILE].every(
  (file) => existsSync(file),
);
// `describe.skip` still RUNS its body to collect the tests, so the file
// reads inside would throw without the frontend checkout (CI has none).
// Skipping must not call the real body at all.
const describeIfAvailable = available
  ? describe
  : (name: string, _body: () => void) =>
      describe.skip(name, () => {
        it('needs the frontend checkout (sibling atlas-front or ATLAS_FRONTEND_ROOT)', () => {});
      });

/** Placeholder ids, so a generated path can never accidentally equal a literal route segment. */
const ID = '__ID__';
const RULE_VALUES: Record<string, unknown> = {
  courseId: ID,
  academyId: ID,
  quizId: ID,
  assignmentId: ID,
  token: 'OPAQUE-TOKEN-VALUE',
};

/**
 * The known-broken destinations, keyed by the thing that has to change.
 *
 * A LEDGER, not an amnesty. The per-key assertion below allows a dead link
 * only if its key is listed here, so a NEW one fails immediately; and a
 * second assertion requires every listed key to still be genuinely dead,
 * so the day one is fixed this list must shrink or the suite goes red. The
 * value is the reason it was not fixed in the audit that found it.
 */
const KNOWN_BROKEN: Partial<Record<CommunicationEventKey, string>> = {
  // NOTE. `auth.password.reset`, `auth.email.verification`,
  // `roster.student.awaiting_approval`, `review.submitted`,
  // `provisioning.completed`, `live_session.recording_available` and
  // `live_provider.deauthorized` were all listed here and have since been
  // FIXED — the first two now point at
  // `/auth/...`, and the two staff work items at
  // `/dashboard/academy/:academyId/...` with the producers carrying
  // `academyId` in `values`. They are removed rather than left as stale
  // exemptions, which the case below enforces.
};

/**
 * Reads the `export const X_ROUTES = { ... }` blocks out of the registry
 * and returns each group's path literals.
 *
 * Parsed rather than imported: the registry lives in another package with
 * its own path aliases and build configuration, and a regex over the
 * source is both cheaper and immune to them. Anything that stops being a
 * plain string literal stops being asserted — which the group-size
 * assertion below is there to catch.
 */
function routeGroups(source: string): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  const header = /export const ([A-Z_]+) = \{/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(source)) !== null) {
    const name = match[1];
    const rest = source.slice(match.index);
    const end = rest.indexOf('\n} as const;');
    const body = end === -1 ? rest : rest.slice(0, end);
    groups[name] = [...body.matchAll(/'(\/[^']*)'/g)].map((m) => m[1]);
  }
  return groups;
}

/**
 * `path="my/*"` literals from the academy-host router, normalised to
 * absolute — WITHOUT its catch-alls.
 *
 * `path="*"` and `path="/ar/*"` are not destinations: they are the
 * data-driven CMS fallback (`PublicWebsiteShell` → `resolvePathToPage`),
 * which renders the academy's own not-found page for anything that is not
 * a published page. Counting them as routes would make EVERY path on an
 * academy host "resolve", which is precisely the silence this spec exists
 * to break. `robots.txt`/`sitemap.xml` are dropped for the same reason:
 * they are files, not pages a person can be sent to.
 */
function publicRouterPaths(source: string): string[] {
  return [...source.matchAll(/path="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((path) => !path.includes('.'))
    .map((path) => (path.startsWith('/') ? path : `/${path}`))
    .filter((path) => path !== '/*' && path !== '/ar/*');
}

/** Whether a concrete path matches one route template (`:param` and `*` match anything). */
function matches(path: string, template: string): boolean {
  const pathSegments = path.split('/').filter(Boolean);
  const templateSegments = template.split('/').filter(Boolean);
  if (templateSegments[templateSegments.length - 1] === '*') {
    const prefix = templateSegments.slice(0, -1);
    return (
      pathSegments.length >= prefix.length &&
      prefix.every((s, i) => s.startsWith(':') || s === pathSegments[i])
    );
  }
  if (pathSegments.length !== templateSegments.length) return false;
  return templateSegments.every(
    (segment, index) => segment.startsWith(':') || segment === pathSegments[index],
  );
}

function strippedPath(url: string): string {
  const withoutQuery = url.split('?')[0].split('#')[0];
  return withoutQuery.replace(/\/+$/, '') || '/';
}

function pathOf(key: CommunicationEventKey): string | null {
  const rule = COMMUNICATION_CATALOG[key].actionUrl;
  if (!rule) return null;
  return strippedPath(rule({ entity: { type: 'entity', id: ID }, values: RULE_VALUES }));
}

describeIfAvailable('every email destination is a real route on its own surface', () => {
  const groups = routeGroups(readFileSync(ROUTE_PATHS_FILE, 'utf8'));
  const publicRouter = publicRouterPaths(readFileSync(PUBLIC_ROUTER_FILE, 'utf8'));
  const pageResolution = readFileSync(PAGE_RESOLUTION_FILE, 'utf8');

  /**
   * Routes served by `AppRouter` — the PLATFORM host only. An academy host
   * never reaches this router: `AppRouter` returns `PublicWebsiteRouter`
   * for the whole tree when the hostname resolves to an academy.
   */
  const PLATFORM_ROUTES = [
    ...(groups.PUBLIC_ROUTES ?? []),
    ...(groups.AUTH_ROUTES ?? []),
    ...(groups.DASHBOARD_ROUTES ?? []),
  ];

  /**
   * Routes served by `PublicWebsiteRouter` — the ACADEMY hosts. The
   * learner surface (`LEARNER_ROUTES`, mounted as `my/*`), the auth and
   * verification pages the academy mounts itself, and the course-details
   * page, which `resolvePathToPage` resolves from data rather than
   * declaring as a `<Route>` and so has to be named here.
   */
  const ACADEMY_COURSE_DETAILS = '/courses/:courseId';
  const ACADEMY_ROUTES = [
    ...(groups.LEARNER_ROUTES ?? []),
    ...publicRouter,
    ACADEMY_COURSE_DETAILS,
  ];

  const routesFor = (key: CommunicationEventKey): string[] =>
    COMMUNICATION_CATALOG[key].branding === 'academy' ? ACADEMY_ROUTES : PLATFORM_ROUTES;

  const resolves = (key: CommunicationEventKey): boolean => {
    const path = pathOf(key);
    return path !== null && routesFor(key).some((template) => matches(path, template));
  };

  it('parsed a plausible route registry (the regex has not silently stopped matching)', () => {
    expect((groups.DASHBOARD_ROUTES ?? []).length).toBeGreaterThan(50);
    expect((groups.LEARNER_ROUTES ?? []).length).toBeGreaterThan(10);
    expect((groups.AUTH_ROUTES ?? []).length).toBeGreaterThan(3);
    expect(publicRouter).toContain('/my/*');
    // The course-details path is data-resolved, not declared; this is what
    // keeps the hardcoded constant above honest.
    expect(pageResolution).toContain('/^\\/courses\\/([^/]+)$/');
  });

  describe.each(
    COMMUNICATION_EVENT_KEYS.filter((key) => COMMUNICATION_CATALOG[key].actionUrl),
  )('%s', (key: CommunicationEventKey) => {
    const surface =
      COMMUNICATION_CATALOG[key].branding === 'academy' ? 'academy' : 'platform';

    it(`lands on a real ${surface}-host route`, () => {
      const known = KNOWN_BROKEN[key];
      const verdict = resolves(key)
        ? 'resolves'
        : known
          ? `known-broken (${known})`
          : 'DEAD LINK';
      expect(`${key} → ${pathOf(key)} on the ${surface} host: ${verdict}`).not.toContain(
        'DEAD LINK',
      );
    });

    it('starts at the root, with no host, scheme or protocol-relative prefix', () => {
      const path = pathOf(key) as string;
      expect(path.startsWith('/')).toBe(true);
      expect(path.startsWith('//')).toBe(false);
      expect(path).not.toMatch(/^https?:/);
    });
  });

  it('carries no stale exemption — every listed key is still genuinely broken', () => {
    for (const key of Object.keys(KNOWN_BROKEN) as CommunicationEventKey[]) {
      expect(
        `${key}: ${resolves(key) ? 'FIXED — remove it from KNOWN_BROKEN' : 'still broken'}`,
      ).not.toContain('FIXED');
    }
  });

  it('the four live-session deep links point a LEARNER at the learner surface', () => {
    // The regression that motivated this spec, pinned by shape: a
    // learner-audience key may not point into the management dashboard.
    for (const key of COMMUNICATION_EVENT_KEYS) {
      const entry = COMMUNICATION_CATALOG[key];
      if (entry.audience !== 'learner' || !entry.actionUrl) continue;
      expect(`${key} → ${pathOf(key)}`).not.toContain('/dashboard/');
    }
  });

  describe('the settings link in every footer', () => {
    const links = new LinkBuilderService(
      {
        getOrThrow: () => ({
          platformWebUrl: 'https://app.atlas.test',
          platformName: 'Atlas',
        }),
        get: () => ({ baseDomain: 'atlas.test' }),
      } as unknown as ConfigService,
      {
        platformDomainConfiguration: { findFirst: async () => null },
      } as unknown as PrismaService,
    );

    it('is absolute and https on both surfaces', () => {
      for (const host of [null, 'falcon.atlas.test']) {
        for (const locale of ['en', 'ar'] as const) {
          expect(links.settings(locale, host).startsWith('https://')).toBe(true);
        }
      }
    });

    /**
     * FIXED. `settings()` used to return `/settings/notifications`, a
     * route on neither surface, so the footer of every email led to a
     * not-found page — and it prefixed `/ar` on the platform host, which
     * mounts no `/ar` subtree, so the Arabic footer was dead twice over.
     *
     * The destination depends on the AUDIENCE, which is why that is a
     * parameter now: a learner manages preferences on their academy host,
     * staff and platform recipients on the management host. These cases
     * assert against the SAME route registry every other destination in
     * this file is checked against, so the footer can never drift back
     * into pointing at nothing.
     */
    it('sends a learner to a real route on the academy surface', () => {
      const path = new URL(links.settings('en', 'falcon.atlas.test', 'learner')).pathname;
      expect(ACADEMY_ROUTES.some((t) => matches(path, t))).toBe(true);
    });

    it('sends staff and platform recipients to a real route on the management surface', () => {
      for (const audience of ['staff', 'platform'] as const) {
        const path = new URL(links.settings('en', null, audience)).pathname;
        expect(PLATFORM_ROUTES.some((t) => matches(path, t))).toBe(true);
      }
    });

    it('never prefixes `/ar` on the platform host, which mounts no `/ar` routes', () => {
      const path = new URL(links.settings('ar', null, 'staff')).pathname;
      expect(path.startsWith('/ar')).toBe(false);
      expect(PLATFORM_ROUTES.some((t) => matches(path, t))).toBe(true);
    });

    it('keeps the `/ar` prefix on the academy host, where it IS mounted', () => {
      const path = new URL(links.settings('ar', 'falcon.atlas.test', 'learner')).pathname;
      expect(path.startsWith('/ar/')).toBe(true);
    });
  });
});
