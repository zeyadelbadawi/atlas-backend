# Who can open Atlas support tickets

**Record:** B0-SUP-02 (default rule OQ-23: learner support stays with the academy). **Status:** rule in force; owner confirmation pending.

## The rule

Atlas support tickets are for the people who run an organization on the **management surface**: organization owners, managers and instructors, signed in on the platform host. **Learners do not open Atlas tickets.** A learner's help is their academy.

| Who | Where they get help |
|---|---|
| Organization owner, manager, instructor | Dashboard → **Support**: an Atlas support ticket. |
| Learner (student of an academy) | **Their academy.** The academy website's Contact page: the footer's "Contact us" link, and "Contact your academy" in the learner dashboard's section menu (`/my/*`). Messages land in the academy's own Contact inbox (owner and manager), not with Atlas. |
| Visitor with no account | The academy's Contact page (for a learner question), or the Atlas marketing contact form (for a question about Atlas itself). |

If a learner's problem needs Atlas (for example, a phone number held by another account, `docs/support/PHONE-NUMBER-CLAIM-RUNBOOK.md`), the **academy owner** opens the Atlas ticket for them from the dashboard. The learner never needs an Atlas account on the management surface to get help.

## Where it is enforced

- `src/platform/controllers/tenant-support-cases.controller.ts` L61–63: every tenant support-case route (`organizations/:id/support-cases`, `academies/:id/support-cases`, `support-cases/mine/...`) runs behind `JwtAuthGuard` and `ManagementSurfaceGuard`. A session minted on an academy website is refused with 403 `errors.auth.managementSurfaceOnly`, whoever holds it: a learner, and even the organization owner's own academy-site session.
- `test/learner-support-path.e2e-spec.ts` L94–117 pins it: learner on the academy site → 403, owner on the academy site → 403, owner on the management surface → 201.
- Academy Contact page: `POST /public/websites/:academyId/contact` (`src/public-website/controllers/public-website.controller.ts` L371) stores the message for that academy's staff.
- Frontend: the learner dashboard has no Support entry; its section menu ends with "Contact your academy" (the academy's own Contact page, drawn only when the site shows one). The management Support route comment says the same (`atlas` `src/app/routes/AtlasAppRoutes.tsx`).

`SURFACE_ENFORCE_MODE` is rollout control for `ManagementSurfaceGuard` (see `docs/COMMUNICATIONS_FEATURE_VERIFICATION_GUIDE.md`, "Configuration caveat"). With `off`, a learner would not be refused by the guard. Production must not run with `off`.

## Not built in B0

- The API accepts academy-scoped tickets (`POST academies/:id/support-cases`), but no UI files one. Tickets created from the dashboard are organization-level.
- There is no learner-facing Atlas help channel, and none is planned in B0.

Anything written for learners (help pages, emails, in-app copy) must send them to their academy. It must never suggest that they can file an Atlas ticket.
