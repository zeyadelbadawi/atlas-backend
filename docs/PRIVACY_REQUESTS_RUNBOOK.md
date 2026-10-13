# Privacy requests: data deletion and data export (B0-SEC-13)

A person asks for a copy of their data, or for their account to be deleted,
from their profile. The request is confirmed by a code emailed to their
verified address, and a Platform Owner handles it from **Platform → Privacy
requests**. No handling time is promised anywhere in the product or the
emails: the owner has not set an SLA (OQ-23), and counsel has not reviewed
the wording (B0-OC-24).

## What the code does

| Step | Who | What happens |
|---|---|---|
| Ask for a code | Requester (`POST /privacy-requests/code`) | A 6-digit code, valid 10 minutes, emailed to the verified address. Same limits as the account-deletion code (5 attempts, 60 s resend cooldown, 5 an hour). The code works only for filing a privacy request: it can never delete an account, and an account-deletion code cannot file a request. |
| File | Requester (`POST /privacy-requests`) | The request is stored (`privacy_requests`). One open request per type: a retry returns the open one. The requester gets a receipt email; every active Platform Owner gets an in-app and email alert (no personal data in the alert). |
| Start | Platform Owner | `submitted → in_progress` (optional). |
| Decline | Platform Owner | `→ rejected`. A reason is required; the person is emailed it and sees it on their profile. They can file a new request afterwards. |
| Fulfil an export | Platform Owner | The request completes. The person can download a JSON copy from their profile for 7 days, signed in. The email has no download link, so a forwarded email gives nothing away. Each download is audited. |
| Fulfil a deletion | Platform Owner | The account is deleted through the existing Platform Owner deletion (`AccountDeletionService.deleteUserAsPlatformOwner`): academies they own are archived, memberships removed, sessions ended, the account anonymised, certificates anonymised. The request completes, a goodbye email goes to the address recorded on the request, and that address is then masked on the row. |

Who can see a request: the person who filed it, and Platform Owners. No
academy staff can, by RLS (`privacy_requests` has no organization policy).
Every step writes an audit row: `privacy_request.code.*`,
`privacy_request.submitted`, `.status_changed`, `.fulfilled`,
`.export_downloaded`, plus `account.deleted_by_platform_owner` for a deletion.

## What the export contains

The person's own rows, read in their own RLS context: account (name, email,
phone, preferences, sign-in dates), academy memberships, enrolments with
progress, lesson progress, quiz results, certificates, course orders and
payments. It leaves out credentials and 2FA secrets, session and device
fingerprints, other people's data (reviewer notes, commission figures) and
operator-internal fields.

## Operator steps

1. Open the request. Check that the person is who they say: the request was
   filed from their signed-in account and confirmed by a code sent to their
   verified address. Ask for nothing else by default (no ID documents).
2. **Export:** click *Prepare download*. Tell the person, if they write in,
   that the copy is on their profile for 7 days.
3. **Deletion:** read the deletion plan on the user's page first (academies
   that would be archived, organizations they own). If they own an
   organization with other members or an active subscription, contact them
   before deleting. Then click *Delete account*. This cannot be undone.
4. **Decline** only with a reason the person can act on (for example, an
   open payment dispute).

## Not decided yet (owner and counsel)

- The handling time to publish (SLA). Until then nothing in the product
  promises one.
- The Privacy Policy wording that describes this process (counsel, B0-OC-24).
- Whether records kept after deletion (payments, audit rows) need a stated
  retention period (B0-SEC-05).

## Rolling back

Hide the entry points in the frontend (the profile card and the Platform
nav item). The table and the `purpose` column are additive; nothing else
depends on them.
