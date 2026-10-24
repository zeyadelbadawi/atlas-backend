# Atlas mobile app — backend additions

The learner app (`zeyadelbadawi/atlas-mobile`) uses the same API as the
academy websites. It authenticates exactly like a browser: the refresh token
stays in the `__Host-atlas_session` cookie (the app keeps a cookie jar) and
the app sends `Origin: https://<academy host>` on `POST /auth/refresh` and
`POST /auth/sign-out`. Nothing about sessions changed for it.

Everything below is additive. With every variable unset, the backend behaves
exactly as before for the web.

## B7 — device label

A User-Agent starting `AtlasApp/<version> (<platform>)` is labelled
`Atlas app on iOS` / `Atlas app on Android` in session and learning-device
lists (`deriveDeviceLabel`, both copies). Browser labels are unchanged.

## B5 — `GET /api/v1/public/mobile/config`

Anonymous, any host, `Cache-Control: public, max-age=60`. Values come only
from the environment:

| Variable | Meaning | Unset |
|---|---|---|
| `MOBILE_MIN_VERSION_IOS` / `_ANDROID` | Older app versions must update first (`MAJOR.MINOR.PATCH`) | `0.0.0` (none blocked) |
| `MOBILE_LATEST_VERSION_IOS` / `_ANDROID` | Newest published version ("update available") | `null` |
| `MOBILE_STORE_URL_IOS` / `_ANDROID` | `https://` store page | `null` |
| `MOBILE_MAINTENANCE_MODE` | `true` shows the app's maintenance screen | `false` |

```json
{ "ios": { "minimumVersion": "0.0.0", "latestVersion": null, "storeUrl": null },
  "android": { "minimumVersion": "0.0.0", "latestVersion": null, "storeUrl": null },
  "maintenance": false }
```

Listed in the route inventory (`route-surface-inventory.spec.ts`); e2e in
`test/mobile-config.e2e-spec.ts`.

## B4 — consent records (`user_consents`)

Terms of Service, Privacy Policy and the 13+ age confirmation, with the
wording version shown and where (`web` | `ios` | `android`).

- `POST /auth/register` accepts an optional `consents`:
  `{ "source": "ios", "termsVersion": "terms-2026-10", "privacyVersion": "privacy-2026-10", "ageConfirmed": true }`.
  Stored only when the request creates a new account. The web does not send
  it; its requests are unchanged. `ageConfirmed` must be `true`.
- `GET /users/me/consents` → the latest acceptance per kind
  (`{ terms, privacy, age_13_plus }`, each `{ version, source, acceptedAt }` or `null`).
- `POST /users/me/consents` (same body) records a new acceptance; 10/min.
- Table: FORCE RLS, own rows only; no UPDATE policy (records are never
  rewritten); DELETE only for the account itself, used by account deletion.
  Migration `20261128000100_user_consents` (additive).
- Account deletion erases them; the privacy export lists them under
  `account.consents`.
- e2e: `test/user-consents.e2e-spec.ts`.

## B3 — App Store / Google Play review access

A reviewer cannot read the demo account's inbox, so a configured review
account skips the academy's emailed sign-in code — narrowly:

| Variable | Meaning |
|---|---|
| `APP_REVIEW_EMAILS` | Comma-separated review account emails |
| `APP_REVIEW_ACADEMY_ID` | The ONE demo academy where they skip the code |

- Both must be set; unset (the default) changes nothing.
- Only on the academy surface of that academy; never for a Platform Owner
  or an organization owner; an authenticator app (TOTP) is still asked.
- Every use writes `auth.otp.app_review_bypass` to the audit log.
- Use accounts with no money or staff role, and clear the variables after
  the review.
- e2e: `test/app-review-access.e2e-spec.ts` (REVIEW-01..05).

## B1 — push notifications

**Off by default.** Nothing is queued or sent unless `FLAG_PUSH_MODE=on`.

| Variable | Meaning |
|---|---|
| `FLAG_PUSH_MODE` | `on` to send; anything else (default) sends nothing |
| `FCM_PROJECT_ID`, `FCM_CLIENT_EMAIL`, `FCM_PRIVATE_KEY` | Firebase service account (FCM HTTP v1). Incomplete → a stub that sends nothing; never a boot failure |

**Devices** (`push_devices`, migration `20261128000200_push_devices`):

- `PUT /users/me/push-devices` `{ token, platform: ios|android, appVersion, locale: en|ar }`
  — academy sessions only (403 otherwise). Bound to the caller's academy
  and session. If another account had registered the same token (the phone
  changed hands), `release_push_token()` (SECURITY DEFINER, decides from
  `app.current_user_id`, returns nothing) removes that row first.
- `DELETE /users/me/push-devices/:id` — own device only (404 otherwise).
- FORCE RLS, own rows only. Account deletion removes them.

**Delivery.** When the communications dispatcher takes an outbox row it
queues one `push` job (job id `push-<outboxId>`, kept a day so dispatch
retries cannot send twice). `PushDeliveryService`:

- uses the same placement as the feed (`notificationContextFor`): an
  academy notification → the recipient's devices on THAT academy; an
  account notice (password, 2FA, sign-in methods) → all their devices;
  management notifications → none;
- only devices whose registering session is still active (signed out,
  revoked or expired sessions get nothing);
- title = academy name (or "Atlas"/"أطلس"), body = a general line for the
  notification type in the device's language (`push-copy.ts`), data =
  `{ kind, context, academyId?, path? }`. No values, amounts or names on
  the lock screen; the app opens `path` and shows the real notification;
- removes dead tokens; retries (3×) only when nothing was sent and a
  failure was transient.

Not yet: per-category push preferences (a device can be removed instead),
badge counts.

e2e: `test/push-devices.e2e-spec.ts` (PUSH-01..08); unit:
`src/push/**/*.spec.ts`.
