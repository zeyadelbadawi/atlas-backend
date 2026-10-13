# Rolling back a release, and pinning the frontend (B0-OPS-13)

All commands run on the VPS as the deploy user, from `/opt/atlas`. None of
them reverts a database migration: a release that changed the schema can
only be fixed forward, or by restoring a backup.

## Which one to use

| Situation | Command |
|---|---|
| A deploy **failed** its health checks | `bash deploy.sh --rollback`. The failed release never became the record, so `.last-good` is still the previous release. |
| A release is **healthy but wrong** (copy, CSP, academy rendering, a backend bug) | `bash deploy.sh --rollback --to 1`. The wrong release has already become `.last-good`; `.last-good.1` is the release before it. |
| Only the **frontend** is wrong and you know the good commit | `bash deploy.sh --pin-frontend <commit-sha>`. Moves Caddy (and the renderer when `ATLAS_SSR=on`) to that build; the backend is not touched. |

Before any of them, check what a rollback would use:

```bash
bash deploy.sh --check-rollback-record          # the current record
bash deploy.sh --check-rollback-record --to 1   # the release before it
```

The check is read-only. It prints each recorded image, whether it is on the
host or in the registry, and whether it is what runs now.

## What each command does

- Every healthy deploy writes `.last-good`. When the images change, the old
  record moves to `.last-good.1` and older ones shift to `.2` and `.3`. A
  fourth goes away. A redeploy of identical images does not rotate.
- After every healthy deploy, unused application images are pruned, **except**
  those named by `.last-good` or `.last-good.1–3`, so all four can be rolled
  back to with the registry unreachable.
- `--rollback --to N` uses `.last-good.N`. Every image is obtained before
  anything changes. Once the stack is healthy, that release becomes the
  record and the release you rolled away from becomes `.last-good.1`. A
  later plain `--rollback` therefore does not bring the bad release back.
- `--pin-frontend <tag>` pulls `atlas-frontend:<tag>` (and
  `atlas-frontend-ssr:<tag>` with SSR on), refuses with nothing changed if
  any is missing, re-tags it as the image the compose file uses, restarts
  only those services, and writes the record when healthy. The next normal
  frontend deploy returns to `:latest`.
- Below `DEPLOY_MIN_FREE_MB` (default 2048) of free disk, `--pin-frontend`
  refuses before pulling. `--rollback` never does.

## Production rehearsal (owner, in a quiet window)

Record the start and end time of each step.

1. `bash deploy.sh --check-rollback-record --to 1`: both images readable.
2. Note the frontend commit currently live (the `x-atlas-version` header,
   or the last frontend deploy run).
3. `bash deploy.sh --pin-frontend <previous-frontend-sha>`. Confirm the
   public site and one academy site load. If SSR is on, check
   `x-atlas-ssr: render`.
4. Return: `bash deploy.sh --pin-frontend <current-frontend-sha>`, or re-run
   the latest frontend deploy.
5. Optional, backend included: `bash deploy.sh --rollback --to 1`, then
   `bash deploy.sh --rollback --to 1` again to come back (the first call made
   the rolled-away release `.last-good.1`).
6. Write the timings and outcome in the ops log.
