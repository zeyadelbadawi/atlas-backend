-- P49a — add `reconnect_required` to the connection status enum.
--
-- SPLIT FROM P49b DELIBERATELY. Postgres cannot use a new enum value in
-- the same transaction that adds it ("unsafe use of new value of enum
-- type"), which is the identical constraint that forced the P43/P43b
-- split for the subscription lifecycle states. This migration only ADDS
-- the label; P49b adds the columns and may then reference it.
--
-- `IF NOT EXISTS` so a re-run is harmless.

ALTER TYPE "live_provider_connection_status" ADD VALUE IF NOT EXISTS 'reconnect_required';
