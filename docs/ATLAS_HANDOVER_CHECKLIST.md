# Atlas — Incoming Session Checklist

For the Claude Code session taking Atlas over. Work top to bottom. Do **not** run a
fresh full-project discovery — the handover package is the baseline.

---

## 1. Orient (read, do not re-derive)

- [ ] `docs/ATLAS_PROJECT_CURRENT_STATE.md` — SHAs, phase, blockers.
- [ ] `docs/ATLAS_PROJECT_HANDOVER.md` — §5 security, §8 deletion, §16 known issues.
- [ ] `docs/ATLAS_PRODUCT_QUALITY_MASTER_PLAN.md` — **governing rules; it wins over
      every other plan.**
- [ ] `docs/ACCOUNT_DELETION_AND_DATA_LIFECYCLE.md` — before any deletion work.

---

## 2. Confirm state (cheap)

```bash
cd atlas-front     && git rev-parse HEAD && git status --short
cd ../atlas-backend && git rev-parse HEAD && git status --short
curl -s -o /dev/null -w '%{http_code}\n' https://atlass.dpdns.org/api/v1/public/plans
```

- [ ] Frontend `4d512f0`, backend `d868382`, both clean.
- [ ] Production returns **200**.
- [ ] If a SHA differs, someone shipped after this handover — read the log before
      assuming anything here is current.

---

## 3. Rules you must not break

- [ ] **Guard decides, RLS independently agrees.** Both, always.
- [ ] `atlas_app` stays `NOSUPERUSER` / `NOBYPASSRLS`. **Never** connect as superuser
      to make something work — RLS is inert for a superuser.
- [ ] No broad or permissive DELETE policy. New ones are narrow, context-scoped and
      justified in the migration.
- [ ] A query outside its tenant/user context **does not error** — it returns a
      confident zero. State the context every new read or write needs.
- [ ] **Backend implementation is not product completion.** No UI → not done.
- [ ] Never log or surface passwords, OTPs, tokens, reset links or provider
      credentials.
- [ ] Do not invent business decisions. State an assumption and proceed, or ask if
      either choice would be unsafe.

---

## 4. Footguns that have already cost real time

- [ ] **Nest resolves DI at bootstrap.** A cross-module provider that is not exported
      typechecks, builds, deploys — then the container refuses to start and every API
      route 502s while the frontend keeps serving. Covered by
      `src/platform/controllers/deletion-module-graph.spec.ts`; extend it for new
      cross-module wiring.
- [ ] **One `@Processor` per BullMQ queue.** A second one silently eats jobs.
- [ ] **No `:` in BullMQ job ids** — it is a key separator.
- [ ] `SubscriptionAccessInterceptor` falls back to a route param named exactly
      `:academyId`. Naming it `:id` silently skips subscription enforcement on
      mutations.
- [ ] Unprefixed routes need `@Version(VERSION_NEUTRAL)` as well as prefix exclusion.
- [ ] `trust proxy` must stay an IP list, never `true`.
- [ ] Repositories take a `tx` from `TenancyContextService`, never `PrismaService`
      directly.
- [ ] Check `lsof -ti:3000` is empty before trusting queue-dependent tests.

---

## 5. Before you ship

- [ ] Targeted tests pass.
- [ ] New tests **proven to bite** — revert the fix and watch them fail. A test that
      cannot fail is worse than none.
- [ ] Frontend typecheck still **34** errors (the accepted baseline), none in your
      files.
- [ ] EN **and** AR keys added together — the parity test is bidirectional and also
      requires `_other` on plural keys.
- [ ] UI work used the project's UI/UX skill; responsive, RTL and accessible.
- [ ] Lint clean on touched files.

---

## 6. Shipping

- [ ] Commit to **`main` directly** — no branches, no PRs (owner decision DL-39).
- [ ] Push; the deploy runs automatically.
- [ ] Wait for run `success` — do not stack another push onto a failing deploy.
- [ ] **Verify production**, do not assume:
      - guarded route → **401 = registered and guarded**; **404 = not deployed**;
      - frontend → entry hash changed **and** grep the specific **lazy chunk**, not
        just the entry.
- [ ] If the deploy fails, check whether the backend container is healthy before doing
      anything else — the site can look fine while the API is entirely down.

---

## 7. Next work, in order

- [ ] **Storage teardown.** The public `MediaStorageProvider` has **no delete method at
      all**; Stream `deleteAsset` is only called by the retention sweep; superseded
      certificate PDFs are orphaned. Until this exists, "deleted" for media means only
      that a database row changed. Build on the retention pipeline: one queue / one
      processor, deterministic colon-free job ids, re-validate at execution time,
      **delete → verify absent → tombstone**, provider-404 counts as success,
      zero-rows-changed on the tombstone is an error.
- [ ] Learner deleted-course/academy fallback — a truthful tombstone, no dead links, no
      exposed content.
- [ ] RLS/e2e deletion tests against real Postgres.
- [ ] Product surface inventory (Platform Owner / Client Owner / Learner) against real
      routes, to find backend capabilities with no UI.

---

## 8. Ask the owner before doing

- [ ] Removing any surplus Platform Owner account — the canonical service refuses to
      delete a Platform Owner by design.
- [ ] Moving `FLAG_VIDEO_RETENTION_MODE` to `on` (deletion) — explicitly **not
      approved**.
- [ ] Starting roadmap phases 11 or 12.
- [ ] Anything needing an OTP or a learner browser session — those need a person.
