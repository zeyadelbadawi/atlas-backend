# Privacy requests: data deletion and data export (B0-SEC-13)

A person asks for a copy of their data, or for their account to be deleted,
from their profile. The request is confirmed by a code emailed to their
verified address, and a Platform Owner handles it from **Platform → Privacy
requests**. The owner approved this runbook on 13 Oct 2026. The handling
times below are an internal **proposal** and are not published: nothing in
the product or the emails promises a time until counsel confirms the
statutory window (B0-OC-24). Counsel has not reviewed this process or the
Privacy Policy wording, and nothing here is legal advice.

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

## Handling times (proposed, 13 Oct 2026; internal until counsel confirms)

Counted in business days (Sunday–Thursday, Egyptian public holidays
excluded) from the moment the request is filed. Filing already requires the
emailed code, so a filed request counts as verified.

| Step | Proposed target | Why |
|---|---|---|
| Receipt to the person | Immediate, automatic | Already sent by the code on filing |
| Platform Owner sees it | Same day | The Platform Owner alert, plus the twice-daily manual check (OQ-23) |
| Start, decline or ask a question | Within 2 business days | Leaves time inside the window below for a deletion that needs contact first |
| Export ready to download | Within 6 business days | See the legal note: the strictest window reported for Egypt's PDPL. The export is one click, so this is achievable for one operator |
| Deletion done | Within 6 business days | As above. A deletion that needs contact first (an owned organization with other members or an active subscription) is started within 2 days, and the person is told why it waits |
| Decline | Same as the step it replaces | Always with a reason the person can act on |

If counsel confirms a longer statutory window, keep the 6-day internal
target anyway. If counsel confirms a shorter one, the product does not
change; only the targets do. If a target is missed, finish the request
first, then note the reason in the audit trail (status note).

### Legal dependencies (for counsel; not confirmed)

1. **Statutory response window.** Egypt's Personal Data Protection Law
   (Law 151 of 2020) and its Executive Regulations (Ministerial Decree
   816 of 2025, 1 Nov 2025) govern data-subject requests. One secondary
   source reports a six-business-day response period (citing Art. 32);
   we could not read the law or the regulation text from here. Counsel
   confirms the window, the start point (receipt or verification) and
   whether an extension is allowed.
2. **Compliance date.** Several firms report that the one-year grace
   period under the Executive Regulations ends on 31 Oct 2026 (one source
   says 1 Nov 2026), with licensing and registration through the data
   protection centre's portal. Whether, and how, Atlas must register or
   license as a controller or processor is a question for counsel now, not
   after launch.
3. **Fees.** Atlas charges nothing for a request. The law reportedly
   allows a fee; we do not propose one.
4. **Who answers.** For learners of an academy, the academy may be the
   controller and Atlas the processor. Counsel decides whether Atlas
   answers directly (as built) or forwards to the academy, and the
   wording either way.
5. **What survives deletion.** Payment and order records, audit rows and
   watermark snapshots are kept after deletion (B0-SEC-05). Counsel
   confirms the legal basis and the retention period for each.
6. **Other jurisdictions.** Learners outside Egypt (for example, the Gulf
   or the EU) may have different windows: GDPR allows one month. The
   6-day target is within those.

## Not decided yet (counsel)

- The statutory window, and whether to publish a handling time (above).
- The Privacy Policy wording that describes this process (B0-OC-24).
- Whether records kept after deletion (payments, audit rows) need a stated
  retention period (B0-SEC-05).

## Rolling back

Hide the entry points in the frontend (the profile card and the Platform
nav item). The table and the `purpose` column are additive; nothing else
depends on them.
