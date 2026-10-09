# Forensic video watermark

**Status: IMPLEMENTED (backend + frontend).** Mandatory on every video an Atlas
player shows. Academy owners cannot turn it off.

## What it is — and what it is not

Atlas cannot stop a screen recording, and does not claim to. Per-viewer
*burned-in* watermarking is not possible on this stack: Cloudflare Stream
watermark profiles are applied per video at upload time, and YouTube is a third
party. So the forensic watermark is a **dynamic overlay drawn by Atlas's
player**, engineered to be hard to remove from a recording and easy to trace:

- a readable label — the code (`7K3QM-X9TR7`) plus a masked hint of the account
  (`l•••@gmail.com`) — that moves to a new random position every 20–45 s;
- a very faint, full-frame, rotated tile of the same code that slowly drifts,
  so a crop or a blur over the label still leaves the code all over the frame;
- a watchdog that pauses playback and reports a tamper event if either layer is
  removed, hidden, shrunk or covered in the page.

It is a **deterrent and a trace**, never described as unremovable.

## The code

Ten Crockford base32 symbols — nine random, one Crockford mod-37 check symbol —
shown as `XXXXX-XXXXX` (`src/forensic-watermark/utils/watermark-code.util.ts`).
Crockford's alphabet has no I, L, O or U, so the common OCR confusions have
one reading. A code whose check value would need one of the extra mod-37
symbols (`* ~ $ = U`) is never issued, so every code is alphanumeric. Lookup
input is normalised: case-insensitive, spaces/dashes/dots dropped, O→0, I/L→1,
Arabic-Indic digits accepted; a single misread symbol fails the check and is
reported as a misread (`errors.watermark.checksumMismatch`), not as "not found".

## Issuance

`ForensicWatermarkService.issueInTransaction` runs inside the transaction that
already decides the grant, in the viewer's own RLS user context (or in none,
for an anonymous preview):

| Surface | Where | Viewer |
|---|---|---|
| `lesson_video` | lesson grant with a hosted video (MP4 / Cloudflare Stream) or a YouTube embed | enrolled learner, or staff previewer (no exemption) |
| `course_preview` | free preview lesson | signed-in visitor, or anonymous (no identity: IP, country, UA, device-cookie hash) |
| `live_session` | `POST live-sessions/:id/join/redeem` | student or host |

One code per *(surface, viewer, session, target)*: the same session watching the
same video again reuses its code (and bumps `last_seen_at`); a new sign-in gets
a new code. Anonymous visitors are keyed by their `atlas_device` cookie, or —
with none — by IP + user agent + UTC day.

Anonymous preview grants share the per-viewer grant ceiling
(`ContentGrantRateLimiter`, 120 per 10 minutes) keyed by client IP, so a
visitor rotating device cookies cannot mint records at flood rate.

**Fail closed.** If the code cannot be issued the grant is refused with
`watermarkUnavailable` (HTTP 503, `errors.learning.watermarkUnavailable`) and no
video credential is signed; the issuance happens after every other refusal and
before the learning lease, so a failure never holds a lease. The live-class
redeem returns `{ joinable: false, reason: 'watermark_unavailable' }` before the
SDK signature is created.

## The record — `forensic_watermarks`

Migration `20261110000300_forensic_watermarks`. Columns: code, session key,
surface, user/organization/academy/course/lesson/live-session ids, session id,
device id, device-cookie hash, session started at, issued at, last seen at,
client IP, country, user agent, device label, tamper count / last tamper, and
`identity_snapshot`.

- **No foreign keys.** The record outlives the account, academy and lesson.
- **Encrypted identity snapshot.** Name, email and phone (read from
  `user_phones` inside the viewer's own context — the only context that admits
  it), the session's sign-in IP/country/device, and the content titles, as
  AES-256-GCM (`WatermarkSnapshotCipher`, AAD = the code, so a snapshot moved to
  another row fails). Key: `WATERMARK_SNAPSHOT_KEY` if set, else HKDF-SHA256 of
  `PAYMENT_CREDENTIALS_ENCRYPTION_KEY` under `atlas.forensic-watermark.snapshot.v1`.
  Never rotate the key source in use: older snapshots become unreadable (the
  lookup then says `snapshotStatus: 'unreadable'`).
- **FORCE RLS.** SELECT: Platform Owner only. DELETE: Platform Owner, and only
  rows last shown more than 90 days ago. No INSERT/UPDATE policy: writes go
  through three SECURITY DEFINER functions that re-implement the self-only rule
  (`forensic_watermark_issue`, `forensic_watermark_touch`,
  `forensic_watermark_record_tamper`). No academy or tenant can read it.
- **Last seen.** Bumped by grant refreshes and by the playback heartbeat
  (Redis-gated to once a minute per session + lesson, and again inside the DB
  function).
- **Tamper reports.** `POST /learning/watermarks/tamper { code }` (optional
  session, per-IP throttle, always 204). Counted only on the caller's own code
  (or, anonymously, the code its own device cookie opened), at most once per
  30 s.

## Account deletion

Deleting an account (self-service or by the Platform Owner) **does not delete
watermark records**: they carry no FK and the snapshot keeps the identity at
issue time, so a leak can be traced after the account is gone. This is
disclosed in the privacy policy and listed as a retained group in the deletion
plan (`forensicWatermarks: retain`). See `ACCOUNT_DELETION_AND_DATA_LIFECYCLE.md`.

## Retention

`WATERMARK_RETENTION_DAYS` (default **730**, min 90, max 3650) after the code was
**last shown**. Pruned by the existing P64 Phase 2 maintenance sweep
(`Phase2MaintenanceService.pruneForensicWatermarks`, BullMQ repeatable job, every
10 minutes), in a Platform Owner context; metrics
`retention_sweep_runs{table="forensic_watermarks"}`. The DB delete policy refuses
anything shown in the last 90 days whatever the configured cutoff.

## Platform Owner lookup

`GET /platform/watermarks/:code` — `JwtAuthGuard`, `ManagementSurfaceGuard`,
`PlatformOwnerGuard`; per-IP throttle (20/min) and per-owner limit
(`WATERMARK_LOOKUP_RATE_LIMIT_MAX`/`_WINDOW_SECONDS`, default 30 per 10 min,
fails closed); `Cache-Control: private, no-store`. Every lookup — found or not —
writes `platform.watermark.looked_up` (context: `found`, `surface`,
`accountLinked`; never PII). The response: current account state
(`active | suspended | deleted | missing | anonymous`, current name/email only
while the account exists), the decrypted identity at issue time, organization /
academy / course / lesson / live-session titles (current, else from the
snapshot), surface, issued / last seen, session id and start, sign-in IP /
country / device, device label + parsed user agent, IP + country, tamper count,
and the other codes issued to the same session (or anonymous device).

Frontend: `/dashboard/platform/watermarks` (Platform Owner only).

## Academy setting — mandatory

`PATCH /academies/:id/content-protection` still accepts `watermark` and
`watermarkText` (the frontend already deployed sends them) and ignores both;
`resolveContentProtection` always returns `watermark: true, watermarkText: null`.
The grant's legacy `watermark.text` now carries `CODE · masked identity`, so even
the previously deployed player draws the forensic code.

## Offline

Videos never play offline. Grants are `no-store`, the frontend never persists
grants (`gcTime: 0`, excluded from the offline query allowlist and the offline
lesson store), and the service worker never touches `/api/*`.

## Cloudflare Stream `accessRules`

Not implemented. Binding the signed token to the viewer's IP would make a token
copied from devtools useless elsewhere, but (a) the official documentation could
not be re-verified from the build environment, and (b) IP binding breaks
legitimate playback whenever a learner's address changes mid-lesson (mobile
carrier NAT, Wi-Fi ↔ cellular, IPv4 vs IPv6 to different hostnames). Country
binding is safer but adds little against same-country re-sharing. Revisit with a
staged rollout and real-device testing.

## Known limitations

- A client overlay can be removed by someone who controls the browser (devtools,
  extensions, a modified player) — the watchdog pauses and reports, but cannot
  make that impossible. A camera pointed at a screen records the overlay.
- Firefox's built-in picture-in-picture button ignores `disablePictureInPicture`
  in some versions; the PiP window shows the video without the overlay.
- Zoom Meeting SDK 6.2 (component view) offers no option to disable its own view
  controls; the overlay covers the SDK container and the frame redirects any
  fullscreen request to itself. Verify with real Zoom before the Live Sessions
  add-on launches.
