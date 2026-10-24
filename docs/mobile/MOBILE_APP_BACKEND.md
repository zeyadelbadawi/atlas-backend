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
