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
