# Phone number — sign-up, profile, verification (pending)

Status: shipped behind no flag (collection + profile); verification **pending**
(no SMS/WhatsApp provider is contracted). Frontend twin:
`atlas-front/docs/USER_PHONE.md`.

## 1. Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Required at sign-up? | **Required in the new sign-up UI** (management *and* academy-learner sign-up). **Optional in the API.** | The owner asked for it at sign-up; in Atlas's primary markets (Egypt / MENA) the phone — mostly WhatsApp — is how people are reached. The API must accept registrations without it because the backend deploys before the frontend (the old page sends no phone, and `forbidNonWhitelisted` would refuse unknown fields the other way round), and Google sign-up collects none. Accounts without a number are asked, dismissibly, on their dashboard. |
| Who can read it? | **Only the account itself.** Not academy staff, not the organization owner, not the Platform Owner. | Least privilege: no current feature needs anyone else to read it. Enforced in the database: `user_phones` is FORCE-RLS'd to `app.current_user_id` (no tenant or platform-owner policy), and no endpoint takes a user id. Granting staff visibility later must be a deliberate migration + product decision (consent copy at sign-up, a roster column, audit). |
| Where is it stored? | Own table `user_phones` (E.164 + chosen ISO country + `verified_at`), **not** a column on `users`. | `users` is the identity directory read by rosters, reviews, search and the platform console in any context — the same reason the password credential left that row (`20261022000000_user_credentials`). |
| Unique? | **No.** | Families and small businesses share numbers; uniqueness would also make sign-up a "is this number registered?" oracle. |
| Which numbers? | **Mobile only**: libphonenumber type `MOBILE` or `FIXED_LINE_OR_MOBILE` (US/Canada and similar plans do not distinguish). Refused: landline, toll-free, premium, shared-cost, VoIP, pager, UAN. | The number exists to reach the person and, later, to verify by SMS/WhatsApp — a landline can receive neither. |
| Validation | Server re-normalises everything with libphonenumber (`max` metadata): supported alpha-2 country, ≤ 32 characters of digits (ASCII/Arabic-Indic), spaces and `+ - ( ) .` only, valid number, **number belongs to the chosen country**, mobile type. Never trusts client normalisation. DB `CHECK`s accept only `^\+[1-9][0-9]{6,14}$` and `^[A-Z]{2}$`. | Garbage like `call me 0100…` or `… ext 5` would otherwise be "extracted" by the parser. |
| Default country (UI) | Browser **time zone** → country (compact map of the product's markets), else **Egypt**. | Egypt is the primary market. The browser *language* region is not used: `en-US` is the default UI locale for many users who are not in the US. |
| Existing account joining an academy via its sign-up form | The typed number is **not** applied to the existing account. | A sign-up form is not an account-settings surface; silently changing a global account (shared by several academies) from one academy's page would surprise. The dashboard prompt asks instead. |
| Changing the number | Clears verification — in the service **and** by a DB trigger on `phone_e164`. Re-saving the same number keeps it and spends no budget. | A verification proves one number. |
| Rate limit | `PUT`/`DELETE /users/me/phone`: 6 changes per account per hour (`profile-phone:<userId>`), 429 `errors.auth.rateLimited`. Registration keeps its own limit. Redis failure → allowed + logged (same as the rename budget). | |
| Logs / audit | The number is never logged or audited. pino redacts `phoneNumber`, `phoneE164`, `e164` (root, 1 and 2 levels, `req.body.phoneNumber`). Audit: `account.phone.updated` {change, country, previousCountry, verificationCleared}, `account.phone.removed` {country, wasVerified} — security category, platform scope, never tenant-visible. | |
| Account deletion | `user_phones` row deleted in `AccountDeletionService.anonymiseAndRevoke` (own RLS context). FK `ON DELETE CASCADE` covers hard deletes. | |
| Data export | Atlas has **no** account data-export feature yet (searched both repos). The number is available to its owner via `GET /users/me/phone`; a future export must include `user_phones`. | |
| Offline cache | The frontend query key is `['user','phone']`; the offline persistence allowlist does not include `user`, and a test pins that. | |

## 2. API

All routes: `JwtAuthGuard`, both surfaces (dashboard and academy website),
subject = the access token's account. Not on `GET /users/me` (that payload is
read on every page and kept in the session).

- `POST /auth/register` — optional `phoneNumber` (as typed) + `phoneCountry`
  (alpha-2). Either present ⇒ both required and validated. Stored in the
  registration transaction for a brand-new account only.
- `GET /users/me/phone` → `UserPhoneResponse`
- `PUT /users/me/phone` `{ phoneNumber, phoneCountry }` → `UserPhoneResponse`
- `DELETE /users/me/phone` → `UserPhoneResponse` (`phone: null`)

```ts
interface UserPhoneResponse {
  phone: null | {
    e164: string; country: string; callingCode: string; nationalNumber: string;
    verified: boolean; verifiedAt?: string; updatedAt: string;
  };
  verification:
    | { available: true; channel: 'sms' | 'whatsapp' }
    | { available: false; reason: 'disabled' | 'provider_not_configured' };
}
```

Field violations (`errors.validation.failed` + `violations[]`):
`validation:invalidPhone`, `validation:phoneCountryMismatch`,
`validation:phoneNotMobile` (field `phoneNumber`),
`validation:invalidPhoneCountry` (field `phoneCountry`), `validation:required`.
DTO validation runs before any row is read, so the answer is identical for
existing and new addresses (no enumeration).

## 3. Migration `20261110000200_user_phone`

Additive only: `CREATE TABLE user_phones` (PK/FK `user_id` → `users` cascade,
`phone_e164 varchar(16)`, `country_code varchar(2)`, `verified_at`, timestamps),
two format `CHECK`s, `ENABLE` + `FORCE ROW LEVEL SECURITY`, four self-only
policies (select/insert/update/delete on `app.current_user_id`), and the
`user_phones_clear_verification_on_change` BEFORE UPDATE trigger. The previous
release never reads the table, so the deploy window is safe.

## 4. Verification — where it will live

`src/identity/phone/phone-verification.service.ts`:
`PhoneVerificationProvider` (adapter interface), the
`PHONE_VERIFICATION_PROVIDER` token (unbound), and `availability()` driven by
`FLAG_PHONE_VERIFICATION_MODE` (`off` default). Nothing sends. The UI shows
"Not verified — verification is coming soon" and never a fake badge.

When a provider is contracted: bind the adapter; add
`POST /users/me/phone/verification` (send a code to the **stored** number only)
and `POST /users/me/phone/verification/confirm`; hash codes, single use, short
TTL, bound to the exact `phone_e164`; meter per account, per number and per IP
(SMS-pumping / toll-fraud is the main cost risk); set `verified_at` in the
owner's RLS context; audit `account.phone.verified` (country only).

## 5. Is there a free WhatsApp OTP option? (researched 2026-10-09)

**No — not for sending OTPs.** Facts (Meta's own pages, as quoted by search;
direct fetches of developers.facebook.com are blocked from the build
environment, so re-check before contracting):

- Since **1 July 2025** the WhatsApp Business Platform bills **per delivered
  template message**, by category (marketing / utility / authentication) and
  recipient country. Authentication templates are charged whether or not a
  customer-service window is open; volume tiers only lower the rate.
  Sources: [Pricing on the WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing),
  [Conversation-based pricing (deprecated)](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/conversation-based-pricing).
- Egypt, as reported from Meta's rate card by third parties: authentication
  ≈ **US$0.0036** per message (+14% VAT), **authentication-international**
  ≈ US$0.065. Sources: [ChatMaxima — Egypt](https://chatmaxima.com/whatsapp-api-pricing/egypt/),
  [Zernio](https://zernio.com/blog/whatsapp-business-api-pricing).
- The only free cases are narrow: a 72-hour **free entry point** window (opened
  by a click-to-WhatsApp ad or Page CTA), and — since **1 October 2026** — a
  free tier of **1,000 service (non-template) messages per month** per number,
  which can only be sent inside a 24-hour window the *user* opened. A sign-up
  OTP to a user who has not messaged the business fits neither. Meta also
  requires a payment method on file (Billing Hub) for chargeable traffic.
  Sources: [Upcoming pricing updates — service and utility messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages),
  [Pricing page](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).
- Unofficial WhatsApp Web automation libraries are against WhatsApp's terms
  and get numbers banned — not an option.

**Most promising low-cost design (not implemented):** *user-initiated
verification* — the profile shows a `wa.me/<atlas-number>?text=<code>` link;
the user sends the code from the phone being verified; the Cloud API webhook
receives the inbound message (inbound messages are not billed) and the server
matches sender number + code. It needs no outbound template, but still needs
a WhatsApp Business Platform account (Meta business portfolio, a dedicated
number, acceptance of Meta's terms, payment method on file), so it is a
product/ops decision, not a free switch.
