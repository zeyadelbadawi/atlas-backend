-- Vodafone Cash, Orange Cash, Etisalat Cash and InstaPay, as DISABLED
-- placeholders (2 Oct 2026).
--
-- The Platform Owner asked for these methods with the account holder
-- "Ziad Gehad" / "زياد جهاد" and placeholder destinations until the real
-- wallet numbers and InstaPay address are provided. The destinations below
-- are deliberately not valid wallet numbers or InstaPay addresses, the
-- rows carry "placeholder": true, and the application refuses to enable a
-- placeholder method in production or to take a payment against one there
-- (PlatformPaymentMethodsService / PaymentService). Entering real details
-- through the Platform Owner console replaces the placeholder.
--
-- Additive and idempotent: inserted only if the key does not exist yet.
INSERT INTO "payment_methods"
  ("id", "key", "type", "display_name", "description", "enabled", "provider",
   "capabilities", "manual_instructions", "display_order", "created_at", "updated_at")
SELECT gen_random_uuid()::text, v.key, v.type::"payment_method_type", v.display_name, NULL, false,
       'atlas_manual',
       '{"supportsManualReview":true,"supportsProof":true,"supportsRedirect":false,"supportsEmbeddedCheckout":false,"supportsAdditionalAuthentication":false,"supportsWebhooks":false,"supportsRefunds":false,"supportsRecurring":false,"supportsCancellation":true}'::jsonb,
       v.instructions::jsonb, v.display_order, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
  ('wallet_vodafone_cash', 'manual_wallet_transfer', 'Vodafone Cash', 20,
   '{"type":"manual_wallet_transfer","walletProvider":"vodafone_cash","walletNumber":"PLACEHOLDER-NOT-A-WALLET","accountName":"Ziad Gehad","accountNameAr":"زياد جهاد","instructions":"Placeholder — the real Vodafone Cash number has not been provided yet. Do not send money.","instructionsAr":"بيانات مؤقتة — لم يُضف رقم فودافون كاش الفعلي بعد. لا ترسل أي مبلغ.","referenceInstructions":"Use your Checkout id as the transfer note.","referenceInstructionsAr":"اكتب رقم عملية الدفع في ملاحظة التحويل.","placeholder":true}'),
  ('wallet_orange_cash', 'manual_wallet_transfer', 'Orange Cash', 21,
   '{"type":"manual_wallet_transfer","walletProvider":"orange_cash","walletNumber":"PLACEHOLDER-NOT-A-WALLET","accountName":"Ziad Gehad","accountNameAr":"زياد جهاد","instructions":"Placeholder — the real Orange Cash number has not been provided yet. Do not send money.","instructionsAr":"بيانات مؤقتة — لم يُضف رقم أورانج كاش الفعلي بعد. لا ترسل أي مبلغ.","referenceInstructions":"Use your Checkout id as the transfer note.","referenceInstructionsAr":"اكتب رقم عملية الدفع في ملاحظة التحويل.","placeholder":true}'),
  ('wallet_etisalat_cash', 'manual_wallet_transfer', 'Etisalat Cash', 22,
   '{"type":"manual_wallet_transfer","walletProvider":"etisalat_cash","walletNumber":"PLACEHOLDER-NOT-A-WALLET","accountName":"Ziad Gehad","accountNameAr":"زياد جهاد","instructions":"Placeholder — the real Etisalat Cash number has not been provided yet. Do not send money.","instructionsAr":"بيانات مؤقتة — لم يُضف رقم اتصالات كاش الفعلي بعد. لا ترسل أي مبلغ.","referenceInstructions":"Use your Checkout id as the transfer note.","referenceInstructionsAr":"اكتب رقم عملية الدفع في ملاحظة التحويل.","placeholder":true}'),
  ('instapay', 'manual_instapay', 'InstaPay', 30,
   '{"type":"manual_instapay","instapayAddress":"PLACEHOLDER-NOT-AN-ADDRESS","accountName":"Ziad Gehad","accountNameAr":"زياد جهاد","instructions":"Placeholder — the real InstaPay address has not been provided yet. Do not send money.","instructionsAr":"بيانات مؤقتة — لم يُضف عنوان إنستاباي الفعلي بعد. لا ترسل أي مبلغ.","referenceInstructions":"Use your Checkout id as the transfer note.","referenceInstructionsAr":"اكتب رقم عملية الدفع في ملاحظة التحويل.","placeholder":true}')
) AS v(key, type, display_name, display_order, instructions)
ON CONFLICT ("key") DO NOTHING;
