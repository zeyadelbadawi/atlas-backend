# Phone number held by another account (support runbook)

**Record:** B0-IAM-05. **Status:** DRAFT, pending owner approval. Not rehearsed yet (the record asks for one staging rehearsal of the operator clear, which cannot happen until an operator path exists, see §5).
**Audience:** Atlas support (the Platform Owner) and the engineer on call. Internal. No phone numbers, emails or names of real people go in this file, in tickets beyond what the case needs, or in the ops log.

## 1. Why this happens

- Every account has at most one phone number, and **a number belongs to one account only** (unique index on `user_phones.phone_e164`, `docs/USER_PHONE.md`).
- Numbers are **not verified**. No SMS or WhatsApp provider is under contract (`src/identity/phone/phone-verification.service.ts`, `FLAG_PHONE_VERIFICATION_MODE` off). So anyone can save someone else's number, by mistake (a typo, a parent's or a colleague's phone) or on purpose.
- The real owner of the number then gets **409 `errors.auth.phoneTaken`** on the phone field when they sign up (`src/identity/services/auth.service.ts` L548 and L784) or save it in their profile (`src/identity/phone/user-phone.service.ts` L223 and L265). The message never says whose account holds the number. It now reads: "This phone number is already used by another account. If it's your number, contact support to reclaim it, or enter a different number." The Arabic text is in the same key (`validation:phoneTaken`, `errors:auth.phoneTaken` in the frontend) and needs a native-speaker check.

There is no self-service recourse. This runbook is the recourse.

## 2. How a claim reaches Atlas

| Claimant | Channel |
|---|---|
| Organization owner, manager or instructor who is signed in | Dashboard → **Support** ticket. |
| Learner of an academy | Their **academy** (its Contact page). The academy owner opens the Atlas ticket for them. Learners do not open Atlas tickets (`docs/support/WHO-CAN-OPEN-SUPPORT-TICKETS.md`). |
| Someone who cannot sign up because of the 409 | The Atlas marketing contact form, or through the academy they were joining. |

Write up each claim as one ticket, or as a contact enquiry linked to a ticket. From here on, "the ticket" means that record.

## 3. Rules

1. **Never tell anyone which account holds a number.** Not its name, email, academy or role. The 409 hides this on purpose.
2. **The claimant proves control of the number before anyone contacts the holding account.**
3. **Change nothing without a record.** Every step goes into the ticket. The ops log gets one line per case (§7).
4. **Do not write SQL to edit the data by hand.** A direct `DELETE` on `user_phones` skips the audit trail. Today the only audited way a number leaves an account is the holder removing it themselves (§5).
5. Store as little as possible. In the ops log, keep only the country and the last two digits of the number (for example `EG …17`), never the full number.

## 4. Steps

### Step 1: Verify the claimant (WhatsApp from that number)

1. Give the claimant a one-time reference: the ticket number plus a random word you choose now. Never reuse it.
2. Ask them to send that reference **as a WhatsApp message from the claimed number** to the Atlas support WhatsApp number. The owner keeps that number with the ops log, never in this repository.
3. Check that the sender shown in WhatsApp is the claimed number exactly, in full international form, and that the message contains the reference.
4. Record in the ticket: "Control verified by WhatsApp on <date>, reference matched." Do not attach screenshots that show the number.

If the claimant cannot do this, stop. Close the ticket as "not verified". They can still register with a different number.

> Limit (owner decision): a WhatsApp message proves that the claimant controls the WhatsApp account on that number today. It does not prove they own the SIM, and a recently recycled number can mislead. A voice call to the number is an acceptable second check where there is doubt.

### Step 2: Find the holding account (engineering, read-only)

The product has no lookup by phone number. `user_phone_taken()` only answers yes or no, and the Platform Owner's Users console searches by name and email only. An engineer does the lookup, after the Platform Owner approves it in the ticket:

- A **read-only** query on the owner database connection. It returns the holding account's **user id** only, never other columns, and the number is typed at the prompt, never saved in a file or a shell history that is kept.
- The engineer writes the user id into the ticket, not the number.

If no account holds the number (for example, the holder has since deleted their account or changed the number), tell the claimant to try again and close the ticket.

### Step 3: Contact the holding account

From the Atlas support mailbox, email the address on the holding account (the Platform Owner's Users console shows it for that user id). Suggested text, EN (an AR version needs native review before use):

> Another person has told Atlas that the phone number saved on your Atlas account is theirs, and has shown us that they control it. If this number is not yours, please remove it or change it in **Profile → Phone number**. If it is yours, reply to this email within 7 days and we will ask you to confirm it the same way. If we do not hear from you, Atlas may remove the number from your account. Nothing else on your account will change.

Do not name the claimant. The 7-day period is a proposal for the owner to decide. Leave out the sentence "If we do not hear from you, Atlas may remove the number from your account" until an operator path exists (§5): today Atlas cannot do that in an audited way.

### Step 4: Resolve the claim

| Holding account's answer | What happens |
|---|---|
| Removes or changes the number itself | This is the normal outcome. `DELETE /users/me/phone` or `PUT /users/me/phone` runs as that account and writes the audit row `account.phone.removed` or `account.phone.updated` with **the holder as actor** (`src/identity/phone/user-phone.service.ts` L272–293 and L201–270). Tell the claimant to try again. Done. |
| Says the number is theirs | Ask them for the same WhatsApp check (Step 1, with a new reference). If they pass and the claimant also passed, the number is shared or recycled: the owner decides. If they do not pass, treat it as "no answer". |
| No answer within the period, or refuses without proof | An operator has to clear the number. See §5. |

### Step 5: Close

Tell the claimant the outcome. Write the ops-log line (§7). Close the ticket.

## 5. Operator clear: no audited path exists today

**Code check (14 Oct 2026):** the audit action `account.phone.removed` (`src/audit-log/catalog/audit-event-catalog.ts` L1107) is written in one place only: `UserPhoneService.removeOwn` (`src/identity/phone/user-phone.service.ts` L272–293). That method is self-service only. It runs for the access token's own subject, in that user's RLS context, with that user as actor. `user_phones` is FORCE-RLS'd to `app.current_user_id`, and no endpoint takes a user id. The only other code that deletes a `user_phones` row is account deletion (`src/identity/services/account-deletion.service.ts` L425), which is not a remedy. **No platform endpoint, console action or operator script clears another account's phone number.**

So, until an operator path is built:

- Do **not** clear the number with a hand-written SQL `DELETE`. It would be an unaudited edit of another person's account.
- Escalate to the owner with the ticket. The claimant can register or keep using a **different number** in the meantime, and switch to theirs in **Profile → Phone number** once the number is freed.

**Engineering follow-up (owner decision, not built):** an operator script `src/scripts/clear-user-phone.ts`, modelled on `src/scripts/reset-two-factor.ts`. Inputs by id only (`CLEAR_ACTOR_ID`, `CLEAR_USER_ID`, `CLEAR_REASON`). It refuses unless the actor is a Platform Owner other than the target. It deletes only that user's `user_phones` row in the target's own RLS context and writes `account.phone.removed` with the **operator as actor** in the same transaction. The catalog entry needs `reason` and an operator marker added to its context fields, so this is a reviewed catalog change. It also needs tests. Once it exists, update this section with the exact command and rehearse it once on staging, which is the record's manual-verification step.

## 6. What this runbook does not do

- It does not verify phone numbers in the product. SMS/WhatsApp verification is deferred until there is a provider (`docs/USER_PHONE.md` §6).
- It does not reveal, export or change anything else on either account.
- It does not move the number to the claimant. The claimant saves it themselves after it is freed, so the uniqueness check and the audit trail apply as usual.

## 7. Ops-log line

`<date> · IAM-05 phone claim · ticket <id> · <country> …<last 2 digits> · claimant verified Y/N · holder outcome (removed itself / disputed / no answer) · operator clear N/A or pending · initials`

## Approval

| Role | Name | Date |
|---|---|---|
| Owner (approves the runbook, the response period and the WhatsApp check) | | |
