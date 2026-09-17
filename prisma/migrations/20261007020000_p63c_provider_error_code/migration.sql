-- P63c — the provider's own numeric error code for the latest refused
-- registration or lookup (e.g. Cloudflare `errors[].code`). A number, never
-- a message: it lets the Platform Owner diagnose WHY custom domains cannot
-- be registered (token permissions, SaaS not enabled on the zone, …)
-- without any credential or raw provider text ever being stored or shown.
-- Additive, nullable; NULL means "no provider error recorded".
ALTER TABLE "domain_connections"
  ADD COLUMN IF NOT EXISTS "last_provider_error_code" TEXT;
