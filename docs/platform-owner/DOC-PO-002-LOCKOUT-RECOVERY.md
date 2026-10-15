---
id: DOC-PO-002
visibility: internal
status: pending owner approval (two-person rule)
---

# DOC-PO-002 · Platform Owner authenticator: enrol before 24 Oct 2026, and recover from a lockout

**Status: PENDING OWNER APPROVAL (two-person rule).** Internal runbook, EN only. Records: B0-OC-01 (enrolment), B0-OC-02 (count check), B0-OC-03 (lockout recovery), B0-SEC-08. Internal target date: **Tue 20 Oct 2026**. Hard deadline: before **2026-10-24T00:00:00Z**.
**Engineering procedure this runbook relies on:** `docs/TWO_FACTOR_LOCKOUT_RECOVERY.md` (R1–R3, with the exact reset command). If the two documents disagree, stop and ask engineering. The code is the source of truth.

**No secrets, ever.** Never put a password, a sign-in code, a QR code, an authenticator key, a recovery code, a token or an environment value in this file, a ticket, a chat, an email, a screenshot or the ops log. Environment variable **names** appear below. Their values never do.

> This repository is public. The page brief marks DOC-PO-* as "never published" and to be kept in a private location (O-4). This text contains no secrets and no personal data, and it repeats what the public code already shows. Where it finally lives is the owner's decision (§8).

---

## 1. Purpose

Every Platform Owner account must have a confirmed authenticator app (TOTP) before the platform consoles start to require one, and there must be a safe, audited way back for anyone who loses theirs.

## 2. Facts (code-verified 14 Oct 2026)

| Fact | Evidence (atlas-backend) |
|---|---|
| From `PLATFORM_OWNER_TOTP_REQUIRED_FROM` (code default `2026-10-24T00:00:00.000Z`; `never` turns enforcement off), every route behind `PlatformOwnerGuard` answers **403 `errors.auth.platformOwnerTwoFactorRequired`** unless the account has a confirmed authenticator. The message shown is "Platform Owner tools need an authenticator app on your account. Set up two-step verification in your security settings, then try again." | `src/identity/guards/platform-owner.guard.ts` L68–88; `src/config/configuration.ts` L709–712 |
| The guard also refuses any session not opened on the **management** surface. Sign in on the platform host, never on an academy website or a custom domain. | `platform-owner.guard.ts` L54–61 (check at L59) |
| **Sign-in and the security settings are not behind this guard.** A Platform Owner who missed the date can still sign in and enrol. | `platform-owner.guard.ts` L68–74 (comment); `test/privileged-mfa.e2e-spec.ts` PMFA-07 |
| Enrolling needs a code from the app **and the account password**. It returns 10 single-use recovery codes, **shown once**. Enrolling again deletes the old codes. | `src/identity/services/two-factor.service.ts` |
| Turning the authenticator on or off is **audited** (`auth.two_factor.enabled`, `auth.two_factor.disabled`) and sends a security email. | `two-factor.service.ts` L262, L452; `src/audit-log/catalog/audit-event-catalog.ts` L1031–1032 |
| A break-glass reset exists: `src/scripts/reset-two-factor.ts` → `TwoFactorService.resetByOperator`. The actor must be a **different** Platform Owner. It removes only the target's authenticator and recovery codes, ends all the target's sessions, writes `auth.two_factor.reset_by_operator` (actor, target, reason) and emails the target. | `src/scripts/reset-two-factor.ts`; `two-factor.service.ts` L486–543; `test/two-factor-operator-reset.e2e-spec.ts` |
| The **Release verify** workflow prints the Platform Owner count, the number with a confirmed authenticator, and the effective enforcement date (counts only, no secrets). | `deploy/release-verify/remote.sh` L60–110; `.github/workflows/release-verify.yml` |
| An account with no password (Google-only) cannot pass the enrolment step, because the password check fails. Set a password first (§4, step 0). | `src/identity/services/password-credentials.service.ts` `verify` |

00:00 UTC on 24 Oct is 03:00 in Cairo `[ASSUMPTION: Egypt on UTC+3 summer time until late October 2026; verify]`. Treat **end of Friday 23 Oct, Cairo time** as the practical deadline.

## 3. Preconditions

- **The list of Platform Owner accounts.** Run **Release verify** (or ask engineering for the same read-only count) and record `platform_owners` and `totp_confirmed` in the ops log. The product shows each holder only their own account.
- Each holder has: a phone with an authenticator app and its clock set to automatic time; the account **password**; a pen and paper, or a printer, for the recovery codes. No screen sharing or recording while enrolling.
- **A second Platform Owner who can act as the reset actor (owner decision).** The break-glass reset (§6, R3) needs an actor who is a Platform Owner and is not the locked-out person. With only one Platform Owner account, nobody can run R3 for that account. Deciding this is the owner's call. This runbook does not create, remove or change any Platform Owner account.

## 4. Steps: enrol (each Platform Owner, personally)

0. **Google-only account?** Sign out, choose **Forgot password?** on the platform sign-in page and set a password first.
1. Sign in on the **platform host** (not an academy site). A new browser may ask for an emailed code first (privileged floor, `AUTH_PRIVILEGED_EMAIL_OTP_FLOOR`).
2. On the dashboard, the notice **"Set up an authenticator app to keep Platform Owner access"** appears. Choose **Open security settings**. The profile opens on its first tab, so choose the **Security** tab.
3. In **Two-Factor Authentication**, choose **Enable**.
4. In **Set up two-factor authentication**, scan the QR code with the app, or use **Can't scan? Enter this key instead**. Do not screenshot, photograph, copy or send the QR code or the key.
5. Enter the **6-digit code from your app** and your **Current password**, then choose **Verify and enable**. If the code is refused, wait for the next one and check the phone's automatic time. Do not retry quickly: the endpoint is rate-limited.
6. **Save your recovery codes:** write or print all ten and keep them offline in a locked place. A second copy may go in a password manager that is **not on the same phone** as the authenticator. Tick **I've saved these codes somewhere safe.** and choose **Done**.

## 5. Verification (record in the ops log, never the codes)

1. The card shows **Enabled** and **10 recovery codes remaining**.
2. The "two-factor enabled" security email arrives.
3. Sign out, open a private window and sign in. The app asks you to "Enter the 6-digit code from your authenticator app." instead of an emailed code.
4. `/dashboard/platform/payments` opens.
5. The Platform Owner notice is gone.
6. **Release verify** reports `every Platform Owner has a confirmed authenticator (N of N)`. Run it on 13–16 Oct, on 21 Oct, and on 24 Oct after 00:00 UTC.

Ops-log line: `<date> · DOC-PO-002 · <account initials> · enrolled and verified 1–5 · <initials>`.

## 6. Contingency: lockout recovery

Full procedure and command: `docs/TWO_FACTOR_LOCKOUT_RECOVERY.md`. This section is the Platform Owner's checklist.

### R1 — Lost or replaced phone, recovery codes available (self-service)
Sign in, choose **Use a recovery code instead** and enter one unused code. Go to Security → **Turn off** (password needed; signs out other sessions), then straight away **Enable** with the new phone (§4, steps 3–6). Re-enrolling cancels all old codes. Platform pages are refused only between turning off and enabling again.
Alternative while the old codes still work: **New recovery codes** in Security (password needed).

### R2 — Old phone still works
Same as R1, using a code from the old phone instead of a recovery code.

### R3 — Phone and recovery codes both lost (break-glass, two-person rule)
Use only when R1 and R2 are impossible.

1. **Identity, out of band.** A second person confirms the requester's identity over a channel already on file (a known phone number or in person). The email of the locked account alone is never enough.
2. **Two-person approval, in writing.** An engineer runs the reset. The owner approves in writing. If the owner is the requester, a named second person approves. The approver and the person running the reset are recorded.
3. **Audited reset by user id.** The engineer runs `src/scripts/reset-two-factor.ts` with the approving Platform Owner as actor, the locked-out user's id as target, and the ticket reference as reason (the exact command is in `docs/TWO_FACTOR_LOCKOUT_RECOVERY.md`). The script refuses a missing variable, an actor who is not a Platform Owner, and a self-reset.
4. **Re-enrol at once.** The user signs in with the password (plus the emailed code where the privileged floor applies) and repeats §4 steps 2–6. A Platform Owner cannot open platform pages until this is done.
5. **Re-check** with Release verify (§5, item 6).
6. **Ops log:** date, who asked, who confirmed identity, who approved, who ran the reset, and the audit row id.

**Never, at any step:** hand-written SQL, a guard bypass, an environment change, or moving `PLATFORM_OWNER_TOTP_REQUIRED_FROM` (to a later date or to `never`) to let someone in. Changing that variable removes the only enforced second factor on platform administration. It would need an explicit, recorded owner decision and is not recommended.

## 7. Audit implications

- Enrolment, turning off and operator resets each write an audit row (`auth.two_factor.enabled`, `.disabled`, `.reset_by_operator`) in the security category, at platform scope. The ops log adds the who-approved-what that the audit row cannot hold.
- Release verify reads only counts and `confirmed_at IS NOT NULL`. It never reads a secret column.

## 8. Approval and open owner decisions

| Item | Decision / sign-off | Date |
|---|---|---|
| This runbook, including the two-person rule in R3 | Owner: | |
| Named second approver when the owner is the requester | Owner: | |
| Whether to keep a second Platform Owner account able to act as reset actor (§3) | Owner: | |
| Where DOC-PO-* live long term (private location, O-4; this repo is public) | Owner: | |
| Staging or local rehearsal of R3 recorded (B0-SEC-08 / B0-OC-03 acceptance) | Engineering: | |

Re-review on 25 Oct 2026, then monthly while CF-10 is open.
