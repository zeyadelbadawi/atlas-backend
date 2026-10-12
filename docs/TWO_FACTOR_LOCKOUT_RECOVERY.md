# Two-factor lockout recovery (runbook)

**Applies to:** every account with two-factor authentication (TOTP), and above all Platform Owners, who must have it to open any platform page once `PLATFORM_OWNER_TOTP_REQUIRED_FROM` has passed (default `2026-10-24T00:00:00Z`).
**Record:** B0-OC-03. **Code:** `TwoFactorService.resetByOperator`, `src/scripts/reset-two-factor.ts`, e2e `test/two-factor-operator-reset.e2e-spec.ts`.

Never store TOTP secrets or recovery codes in a repository, a ticket, a chat or a planning file. Keep recovery codes offline (printed, or in a password manager the owner alone controls).

## R1 — Lost or replaced phone, recovery codes available

1. Sign in with email and password.
2. On the code screen choose **Use a recovery code instead** / «استخدم رمز استرداد بدلًا من ذلك» and enter one unused code.
3. Go to Profile → Security → Two-Factor Authentication → **Turn off** (password required).
4. Immediately **Enable** again with the new phone, confirm with a code and your password, and store the 10 new recovery codes offline. Re-enrolment invalidates every old code.

Platform pages are refused only for the minutes between steps 3 and 4.

## R2 — Old phone still works

Same as R1, using a code from the old phone instead of a recovery code.

## R3 — Phone and recovery codes both lost (break-glass)

Use this only when R1 and R2 are impossible.

1. **Confirm identity out of band.** A second person confirms the requester's identity over a channel already on file (a known phone number or an in-person check), never only via the email of the locked account.
2. **Two-person rule.** An engineer runs the reset. The owner approves it in writing (if the owner is the requester, a named second person approves).
3. **Run the audited reset** inside the backend container, by user **id** (never email), with a short reason or ticket reference:

   ```sh
   RESET_ACTOR_ID=<approving platform owner uuid> \
   RESET_USER_ID=<locked-out user uuid> \
   RESET_REASON="<ticket or short reason>" \
     node dist/scripts/reset-two-factor.js
   ```

   The script refuses if the actor is not a Platform Owner or is the target, or if any variable is missing. It prints whose factor it is about to reset, then:
   - removes only that user's TOTP and recovery codes;
   - signs that user out everywhere;
   - writes one audit row, `auth.two_factor.reset_by_operator`, naming the operator, the target and the reason;
   - emails the user that two-factor authentication was turned off.
4. **Re-enrol at once.** The user signs in with their password (plus the emailed sign-in code where the privileged email-code rule applies) and enables two-factor authentication again. A Platform Owner cannot open platform pages until they do.
5. **Re-check** the Platform Owner TOTP count (B0-OC-02).
6. **Log it** in the ops log: date, who asked, who approved, who ran it, the audit row id.

At no point is an environment variable changed, a guard bypassed, or SQL written by hand. `PLATFORM_OWNER_TOTP_REQUIRED_FROM` is never moved to get someone in.

## If the only Platform Owner is locked out

The reset needs a second Platform Owner as the actor. If there is only one, provision a second Platform Owner account in advance with `src/scripts/provision-platform-owner.ts`, held by a trusted person and enrolled in TOTP itself. Doing this before 24 Oct 2026 is the cheapest protection against a permanent lockout.
