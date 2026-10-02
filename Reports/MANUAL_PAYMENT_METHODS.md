# Manual payment methods — Bank Transfer, E-Wallets, InstaPay

Status (2 Oct 2026): implemented and tested; production needs the Platform
Owner's real details before any method is enabled (below). Nothing here is
a payment gateway: every method is a manual transfer that the Platform
Owner confirms against an uploaded receipt.

## What customers get

An Organization Owner buying an Atlas plan (monthly, or yearly where the
plan has a yearly price) picks an **enabled** method at checkout:

| Kind | Shows | Type |
|---|---|---|
| Bank Transfer | bank, account holder, account number, optional IBAN / SWIFT | `manual_bank_transfer` |
| E-Wallet | provider (Vodafone Cash, Orange Cash, Etisalat Cash, WE Pay, or another by name), wallet number, account holder | `manual_wallet_transfer` |
| InstaPay | InstaPay address (`name@instapay`), account holder | `manual_instapay` |

The payment keeps a **snapshot** of the details it was created with
(`payments.instructions_snapshot`), so later edits never change what a
customer was told. The customer uploads a receipt/screenshot (PNG, JPEG or PDF up to 10 MB,
checked by content, kept in private storage); the
Platform Owner approves (the plan becomes active, server-side, in one
transaction) or rejects with a note. Repeated requests and approvals take
effect once; every step is audited (account details are never copied into
the audit log). Account holder, instructions and reference instructions
are shown in Arabic when an Arabic version is configured, English
otherwise.

Brand marks: no official logos are bundled — their authenticity and
licence could not be verified — so providers are shown with a neutral
text treatment (`manual-payment-brands.ts` in the frontend is the one
place to add verified assets later).

## Placeholders (what is in the database after the migration)

Migration `20261102000400_egypt_manual_payment_placeholders` adds four
**disabled** methods with the account holder **Ziad Gehad / زياد جهاد**
and destinations that are deliberately not valid:

| Key | Display name | Destination stored |
|---|---|---|
| `wallet_vodafone_cash` | Vodafone Cash | `PLACEHOLDER-NOT-A-WALLET` |
| `wallet_orange_cash` | Orange Cash | `PLACEHOLDER-NOT-A-WALLET` |
| `wallet_etisalat_cash` | Etisalat Cash | `PLACEHOLDER-NOT-A-WALLET` |
| `instapay` | InstaPay | `PLACEHOLDER-NOT-AN-ADDRESS` |

They carry `placeholder: true`. In **production** the API refuses to
enable a placeholder (409 `errors.paymentMethod.placeholderDetails`) and
refuses a payment against one; outside production they can be enabled for
testing and every screen marks them "placeholder — do not send money".
Saving real details through the console replaces the placeholder.

## What the Platform Owner must enter (production)

Console → **Atlas subscription payment provider** → manual payment
methods. For each method you want to offer, **Edit**, enter the verified
details, save, then **Enable**:

- **Vodafone Cash / Orange Cash / Etisalat Cash** — the wallet number
  (11 digits, `010…`/`011…`/`012…`/`015…`; `+20` accepted), the account
  holder as registered with the wallet (English; Arabic optional), the
  customer instructions and the reference instructions (English; Arabic
  optional). A WE Pay or other wallet can be added with **Add e-wallet**
  (other providers need their name).
- **InstaPay** — the InstaPay address (`yourname@instapay`), the account
  holder, the instructions and reference instructions.
- **Bank Transfer** — **Add bank account**: bank name, account holder,
  account number, IBAN and SWIFT if any, instructions, reference
  instructions (Arabic optional).
- Optional: a **yearly price** per plan (plan editor) to offer yearly
  billing.

Disable any method you do not offer; a method is never deleted (payments
keep referring to it).

## API (Platform Owner only)

`GET /platform-payment-methods` · `POST /platform-payment-methods/bank-transfer`
· `POST /platform-payment-methods/wallet` · `POST /platform-payment-methods/instapay`
· `PATCH /platform-payment-methods/:id` (`instructions` for a bank,
`walletInstructions` for a wallet, `instapayInstructions` for InstaPay;
another kind is refused). Customers: `GET /payment-methods` (enabled only),
the existing checkout, payment, proof and review endpoints.

## Tests

Backend: `test/bank-transfer.e2e-spec.ts`, `test/manual-payment-methods.e2e-spec.ts`,
`src/billing/services/placeholder-payment-methods.spec.ts`. Frontend: the
billing component/page tests and the browser journeys J16 (Bank Transfer)
and J20 (E-Wallets and InstaPay). Production check: the `Release verify`
workflow reports placeholders (none may be enabled) and methods per type.
