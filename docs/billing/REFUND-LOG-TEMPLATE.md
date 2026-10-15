# DRAFT — pending legal review (RV-04); not published; Terms unchanged

# Subscription refund log (template for the Platform Owner)

**Record:** B0-BIL-09. **Kept by:** the Platform Owner. **Applies to:** money Atlas returns to an organization for an **Atlas subscription** payment, including money returned for a payment Atlas never approved.

**Why a log:** the product has no subscription refund feature and cannot store a note on a reviewed payment (`REFUND-POLICY-DRAFT.md` Part A, A3–A4). Until a refund record exists in the product (EP-31, deferred), this log is the **only** record of a subscription refund. Log every refund, whether or not the refund policy has been published.

**Not for:** course fees learners pay to academies. Those are the academy's to refund (A8), and Atlas does not log them.

## Where the log lives

- **A private location chosen by the owner** (for example the owner's workspace or a private spreadsheet), next to the ops log. **Never in this repository**, which is public, and never in a ticket body or a chat.
- Copy this template's columns there. This file stays empty of real data.

## What to record, and what not to

- Record **ids**, not personal data: the organization id and the Atlas payment id (both from the Payment Review page). Do not record names, emails, phone numbers or full bank, wallet or InstaPay details.
- For the transfer back, record the **method** and **the last 4 characters** of the transfer reference only.
- Do not attach screenshots of bank apps or transfer receipts here. If counsel says proof must be kept, store it where counsel advises and only note "proof kept: Y".
- How long to keep entries is a question for counsel (`REFUND-POLICY-DRAFT.md` Part D, question 4).

## Columns

| Column | What to write | Example (fake) |
|---|---|---|
| `log_id` | Running number, never reused | `R-0001` |
| `requested_on` | Date the customer asked (or Atlas noticed, for clause 3 and 4 cases) | `2026-11-02` |
| `ticket` | Support ticket id | `ticket 1234` |
| `organization_id` | From Payment Review | `00000000-0000-0000-0000-000000000000` |
| `payment_id` | The Atlas payment id the refund relates to | `00000000-0000-0000-0000-000000000000` |
| `payment_state` | `approved` / `rejected` / `never matched` | `approved` |
| `plan_and_cycle` | Plan key and cycle at the time of payment | `growth · monthly` |
| `amount_paid_egp` | Amount Atlas received | `2,790.00` |
| `refund_amount_egp` | Amount to return | `2,790.00` |
| `reason` | One of: `not_accepted` (policy clause 3), `duplicate_or_wrong_amount` (4), `change_of_mind` (5), `service_not_provided` (6), `goodwill` (outside the policy), `other` | `duplicate_or_wrong_amount` |
| `policy_clause` | Clause of the published policy applied, or `case-by-case (Terms §10)` until one is published | `case-by-case (Terms §10)` |
| `decision` | `approved` / `refused` / `partial` | `approved` |
| `decided_by` | Initials of the person who decided | `PO` |
| `decided_on` | Date | `2026-11-03` |
| `subscription_action` | What happened to access: `none` / `customer cancelled (access to period end)` / `plan changed (audited)` / `days granted instead (audited)` / `engineering action (ticket)` | `none` |
| `returned_on` | Date the transfer was sent | `2026-11-05` |
| `method` | `bank transfer` / `wallet` / `InstaPay` | `InstaPay` |
| `transfer_ref_last4` | Last 4 characters of the transfer reference | `7Q2K` |
| `transfer_fee_egp` | Fee paid, and who bore it | `0.00 (Atlas)` |
| `customer_told_on` | Date the customer was told the money was sent | `2026-11-05` |
| `notes` | Short. No personal data. | `paid twice for Nov` |

### Blank row to copy

| log_id | requested_on | ticket | organization_id | payment_id | payment_state | plan_and_cycle | amount_paid_egp | refund_amount_egp | reason | policy_clause | decision | decided_by | decided_on | subscription_action | returned_on | method | transfer_ref_last4 | transfer_fee_egp | customer_told_on | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | | | | | | | | | | | |

## Steps for each refund

1. Open the ticket and create the log row (`requested_on`, `ticket`, ids, amounts, reason).
2. Check the payment in **Payment Review**: its state, amount and plan. For "not accepted" cases, confirm the money actually arrived in Atlas's account before deciding.
3. Decide, and fill in `decision`, `decided_by` and `decided_on`. Until a policy is published, every decision is "case by case" (Terms §10). Do not promise a refund in writing before deciding.
4. If access should change, use only the audited Platform Owner actions (change plan, grant days) or ask engineering. The product cannot shorten a paid period (A6). Record the result in `subscription_action`.
5. Send the transfer **to the account the payment came from**, then fill in `returned_on`, `method`, `transfer_ref_last4` and `transfer_fee_egp`.
6. Tell the customer through the ticket, fill in `customer_told_on`, and close the ticket.
7. Add the ops-log line: `<date> · BIL-09 refund · <log_id> · <decision> · <initials>`.

## Monthly check

Once a month, compare the log with Atlas's bank, wallet and InstaPay statements, so that every outgoing refund has a row and every row has a transfer. Record the check in the ops log.
