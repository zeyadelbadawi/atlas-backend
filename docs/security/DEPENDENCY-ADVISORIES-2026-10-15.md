# Backend dependency advisories — 2026-10-15

Scope: every **high/critical** advisory `npm audit` reports for `atlas-backend`
on 2026-10-15 (npm 10.9.7, Node 22 locally; CI and the Docker image use Node 20).
It follows U-05, which listed multer, lodash and js-yaml from memory. This
list comes from running `npm audit --json` and `npm audit --omit=dev --json`
before and after the change.

## Before / after

| | critical | high | moderate | low | total |
|---|---|---|---|---|---|
| `npm audit` before | 1 | 41 | 42 | 4 | 88 |
| `npm audit` after | **0** | **33** | 45 | 2 | 80 |
| `npm audit --omit=dev` before | 0 | 4 | 31 | 1 | 36 |
| `npm audit --omit=dev` after | **0** | **0** | 31 | 1 | 32 |

npm counts *packages*, not advisories. All 33 highs that remain come from one
dev-only advisory (braces, see below) that has no patched release. The
moderate count goes up by 3, but no new advisory appears: comparing advisory
IDs before and after shows 27 fixed and 0 new. Three packages
(`@nestjs/platform-express`, `js-yaml@3`, and the istanbul parents of
`js-yaml@3`) used to be counted as high. With their highs fixed, npm now counts
them under the older moderates they still have (`@nestjs/core` GHSA-36xv,
body-parser, argparse/sprintf-js).

## Advisories and what was done

"Prod" means the package is in `npm ci --omit=dev` (the runtime image).

| Package (installed) | Path | GHSA (sev) | Vulnerable / patched | Prod? | Disposition |
|---|---|---|---|---|---|
| multer 2.0.2 | `@nestjs/platform-express@10.4.22` (exact pin) | xf7r-hgr6-v32p, v52c-386h-88mc, 5528-5vmv-3xc2, 72gw-mp4g-v24j, wc9g-mqfw-jrwm, 535w-7cp7-47q4 (high) | <2.3.0 / 2.3.0; 2.3.0 also has GHSA-3pph-fpjx-jg34 (mod, >=2.2.0 <2.4.0) | yes | **Fixed**: override → 2.4.0 |
| lodash 4.17.21 | `@nestjs/config@3.3.0`, `@nestjs/swagger@7.4.2` (exact pins); dev: inquirer, node-emoji | r5fr-rjxr-66jc (high) + f23m-r3pf-42rh, xxjr-mmjv-4gpg (mod) | <=4.17.23 / 4.18.0 | yes | **Fixed**: override → 4.18.1; dev copies deduped to it |
| js-yaml 4.1.0 | `@nestjs/swagger@7.4.2` (exact pin); dev: eslint, cosmiconfig | 52cp-r559-cp3m, 5p4m-2wfm-xmqj, 2883-xcg3-v3hh (high) | <4.3.2 / 4.3.2 | yes | **Fixed**: override → 4.3.2; dev copies deduped to it |
| js-yaml 3.15.1 | `ts-jest → babel-plugin-istanbul → @istanbuljs/load-nyc-config` | 2883-xcg3-v3hh (high) | <3.15.2 / 3.15.2 | dev | **Fixed**: lockfile only (`^3.13.1`) |
| handlebars 4.7.9 | `ts-jest@29.4.12` | 8r5x-fm3f-whwj, p8wg-vrv2-v86f (**critical**) | <=4.7.9 / 4.7.10 | dev | **Fixed**: lockfile only (`^4.7.9`) |
| brace-expansion 1.1.18 / 2.1.4 / 5.0.9 | minimatch under eslint, jest, glob, @nestjs/cli, typescript-eslint | qhr7-859c-m2p7, 6j4f-fj2g-mc7p (high) | 1.1.20 / 2.1.6 / 5.0.11 | dev | **Fixed**: lockfile only → 1.1.21 / 2.1.7 / 5.0.12 |
| glob 10.4.5 | `@nestjs/cli@10.4.9` (exact pin) | 5j98-mcp5-4vw2 (high) | >=10.2.0 <10.5.0 / 10.5.0 | dev | **Fixed**: override → 10.5.0 |
| picomatch 4.0.1 | `@angular-devkit/core@17.3.11` (exact pin, via @nestjs/cli); ts-loader, fdir | c2c7-rcm5-vvqj (high) | <4.0.4 / 4.0.4 | dev | **Fixed**: override → 4.0.7; others lockfile → 4.0.7 (tinyglobby keeps its own 4.0.5) |
| tmp 0.0.33 | `@nestjs/cli → inquirer@8.2.6 → external-editor@3.1.0` | ph9p-34f9-6g65 (high); 0.2.6 has 7c78-jf6q-g5cm (high) | <0.2.7 / 0.2.7 | dev | **Fixed**: override → 0.2.7 |
| braces 3.0.3 | `@nestjs/cli → chokidar@3.6.0`; `jest → micromatch@4.0.8` | vfj7-8cjw-p6xm (high) | <=3.0.3 / **none** | dev | **Not fixed**: no patched release exists (latest is 3.0.3, from 2024-09) |

Already done before this change: proxy-addr 2.0.8 (f11e0eb).

## Can each advisory be reached in Atlas?

- **multer: not reached today.** Nothing in `src/` uses `FileInterceptor`,
  `FilesInterceptor`, `AnyFilesInterceptor`, `FileFieldsInterceptor` or
  `MulterModule`. multer only runs when one of those interceptors is applied
  (`@nestjs/platform-express/multer/interceptors/*`). `ExpressAdapter`
  registers only the JSON and urlencoded parsers. Files reach the API as base64
  JSON (`src/platform/dto/support-attachment.dto.ts:4-8`) or as presigned PUTs
  sent straight to storage. The per-route JSON limits live in
  `src/common/http/body-limits.ts:1-30` and are applied in `src/main.ts:47-57`.
  We fixed it anyway: it is in the runtime image, and adding one
  `FileInterceptor` later would make it reachable by anonymous callers.
- **lodash: not reached.** `_.template` is the only target of GHSA-r5fr, and
  nothing in the runtime tree calls it. `@nestjs/config` uses `lodash/get`,
  `has` and `set` with keys from our own code (`config.service.js:46-48`).
  `@nestjs/swagger` uses `omit`, `pick`, `mapValues` and similar on decorator
  metadata at boot. No request input goes into `unset`/`omit` paths.
- **js-yaml 4 (prod): not reached.** All three advisories are about parsing
  (`load`). The only runtime user is `@nestjs/swagger`
  (`swagger-module.js:138`), and it only calls `jsyaml.dump()` on the OpenAPI
  document Atlas generates itself. Swagger is mounted only when
  `!config.isProduction` (`src/main.ts:150-162`). No code in `src/`,
  `scripts/`, `test/` or `prisma/` loads YAML.
- **Dev-only (handlebars, brace-expansion, glob, picomatch, tmp, js-yaml 3,
  braces):** these run only on developer machines, in CI, and in the Docker
  `build` stage, never in the runtime image (`npm ci --omit=dev`). handlebars
  runs only inside `ts-jest config:init`. glob's issue is in its CLI `-c`
  flag, which nobody calls. tmp is used only by the interactive editor prompt
  in `nest` schematics. braces, brace-expansion and picomatch only see glob
  patterns from our own config files.

## The change

`package.json` gets scoped `overrides`. Each one applies only under the parent
that pins the vulnerable version exactly. All are patch/minor upgrades within
the same major, and no NestJS, Prisma or Jest major changes.

```json
"overrides": {
  "@nestjs/platform-express": { "multer": "2.4.0" },
  "@nestjs/swagger": { "js-yaml": "4.3.2", "lodash": "4.18.1" },
  "@nestjs/config": { "lodash": "4.18.1" },
  "@nestjs/cli": { "glob": "10.5.0" },
  "@angular-devkit/core": { "picomatch": "4.0.7" },
  "external-editor": { "tmp": "0.2.7" }
}
```

Why overrides: `@nestjs/platform-express` 10.4.22, `@nestjs/swagger` 7.4.2,
`@nestjs/config` 3.3.0 and `@nestjs/cli` 10.4.9 are already the newest releases
of their majors, and each pins the vulnerable child exactly. The fixed parents
are in 11.x/12.x, and moving NestJS to 11/12 is a separate, reviewed upgrade.

How to rebuild the lockfile from the previous lockfile:
`npm install` then
`npm update js-yaml lodash picomatch handlebars brace-expansion`.
Running `npm install` again leaves the lockfile unchanged, and `npm ci` from it
succeeds with `npm ls` clean. Lockfile changes: multer 2.0.2→2.4.0 (drops
mkdirp, object-assign, xtend, concat-stream from its dependencies), lodash
4.17.21→4.18.1, js-yaml 4.1.0→4.3.2 and 3.15.1→3.15.2, handlebars
4.7.9→4.7.10, brace-expansion 1.1.18→1.1.21, 2.1.4→2.1.7 and 5.0.9→5.0.12,
glob 10.4.5→10.5.0 (now nested under @nestjs/cli), picomatch 4.0.1→4.0.7, tmp
0.0.33→0.2.7 (drops os-tmpdir).

## Breaking-change review

Most upstream changelogs are not shipped in the tarballs, and GitHub release
pages were not reachable from this session. So each published tarball was
diffed against the installed version.

- **multer 2.0.2 → 2.4.0** (minor releases, engines `>=10.16.0`). Changes:
  - Async context is now kept across busboy events.
  - Aborted or errored requests now clean up partial files and drain the body.
  - Opt-in `limits.fieldNestingDepth` and `limits.fieldArrayIndexLimit`.
  - Field names and filenames now decode `%0A`/`%0D`/`%22` (WHATWG).
  - `limits` are validated when the middleware is built (a `TypeError` on bad
    values), and `limits` may now be a function.
  - New options: `defParamCharset`, `defCharset`, `highWaterMark`, `fileHwm`,
    `streamHandler`.
  - New error codes `LIMIT_FIELD_NESTING`, `LIMIT_FIELD_ARRAY_INDEX`,
    `INVALID_FIELD_NAME`, `STREAM_DESTROYED`. Nest 10's `transformException`
    (`multer.utils.js`) does not map these, so they would surface as 500
    rather than 400. Only an endpoint that enables the new limits would hit
    this, and Atlas has no multer endpoints.

  A smoke check through Nest's `FileInterceptor` with the override still
  returns 201 for an upload and 413 for an oversize file.
- **lodash 4.17.21 → 4.18.1.** Changes:
  - `_.unset`/`_.omit` refuse `__proto__` paths and non-terminal
    `constructor`/`prototype` segments.
  - `_.fromPairs` defines keys as own properties.
  - `_.template` copies only own `options`/`imports` and rejects imports keys
    that are not identifiers.

  4.18.1 was picked over 4.18.0 because 4.18.0's modular `lodash/template.js`
  uses `arrayEach`/`assignWith` without requiring them.
- **js-yaml 4.1.0 → 4.3.2.** The source was reformatted. The loader gains
  `maxDepth` (default 100) and `maxTotalMergeKeys` (default 10000) caps.
  `dump` options are unchanged. Smoke check: `/docs-yaml` returns 200 and the
  output round-trips through `load`.
- **js-yaml 3.15.1 → 3.15.2:** a patch that fixes the merge-key CPU limit.
- **handlebars 4.7.9 → 4.7.10** (release notes: seven security fixes).
  Compatibility note: `{{#each}}` now walks iterables lazily. ts-jest's
  `config:init` template does not use iterables. This release is 10 days old.
- **glob 10.4.5 → 10.5.0:** the library API is unchanged. Only the CLI
  changes (`-c` no longer uses a shell by default; new `--shell` and `-g`
  flags).
- **picomatch 4.0.1 → 4.0.7, brace-expansion patches:** fix recursion and
  ReDoS bugs. The API is unchanged.
- **tmp 0.0.33 → 0.2.7** (0.x minor, engines `>=14.14`). external-editor only
  calls `tmp.tmpNameSync(options)`, which has the same signature in 0.2.x.
  0.2.x rejects absolute or traversing `name`/`prefix`/`postfix`/`dir` values,
  which is the fix itself.

## What was run after the change

- `npm run lint`: 0 errors (5 existing `no-console` warnings).
- `npm run typecheck` (with `NODE_OPTIONS=--max-old-space-size=3072`): pass.
- `npm run build`: pass.
- `npx jest`: 252 suites passed, 1 failed, 2 skipped; 6052 tests passed, 4
  failed, 2 skipped.
  - All 4 failures are in the wall-clock "linear time" assertions of
    `rich-text-sanitizer.spec.ts`. That module imports no dependency. The run
    happened at load average 12.7 on 4 CPUs.
  - Run alone, the suite passes 41/41.
- e2e, one at a time, with `redis-cli -n 11 flushdb` before each:
  - media: 22/22
  - media-protected-library: 5/5
  - p53-support-attachments: 16/16
  - bank-transfer: 7/7
  - academy-manual-payments: 15/15
  - academies: 10/10
  - body-limits: 2/2
  - auth-register: 11/11
  - platform-contact-submissions: 23/23

## What is left and follow-ups

1. **braces GHSA-vfj7-8cjw-p6xm (high, dev-only, no fix exists).** It is
   stack exhaustion from deeply nested brace patterns. The patterns come only
   from our own build and test config, never from users, and braces is not in
   the runtime image. The blockers are upstream: braces has no release past
   3.0.3, and micromatch@4 (Jest 29) and chokidar@3 (@nestjs/cli 10) depend on
   it. Follow-up: pick up a patched braces when one ships. Otherwise this goes
   away with Jest 30 and @nestjs/cli 11+, which are major upgrades to plan
   separately.
2. **The overrides are a stopgap.** They should be deleted when NestJS moves
   to 11/12, whose packages pin fixed versions. Until then, a future
   `@nestjs/*` patch release that changes these pins could conflict with the
   overrides. `npm ls` will report that as `invalid`.
3. **Production moderates/lows are unchanged and out of scope:**
   - `@nestjs/core` GHSA-36xv-jgw5-4q75 (≤11.1.17, needs Nest 12)
   - body-parser GHSA-v422 (low)
   - qs (GHSA-q8mj, x5fp, 4mjr)
   - file-type via `@nestjs/common`
   - `@opentelemetry/*` via `@sentry/node` 8 (fix needs Sentry 11)

   These need their own triage.
