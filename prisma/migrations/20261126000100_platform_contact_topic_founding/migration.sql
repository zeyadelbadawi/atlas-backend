-- B2 — Founding Academies. A visitor reaching `/contact?topic=founding`
-- applies for the founding programme; the Platform Owner inbox files the
-- enquiry under its own topic. Additive: a new enum value only, existing
-- rows, values, RLS policies and CHECK constraints are untouched (the sales
-- qualification CHECKs constrain answer values, not the topic).
ALTER TYPE "platform_contact_topic" ADD VALUE IF NOT EXISTS 'founding';
