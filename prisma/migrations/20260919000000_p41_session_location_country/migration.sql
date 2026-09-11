-- Phase 11.9 — a trustworthy, human-readable location for a session.
--
-- WHERE THE VALUE COMES FROM. Cloudflare sits in front of every
-- production request and adds `CF-IPCountry` at the edge. It was verified
-- as actually arriving before this column was added — production request
-- logs show `"cf-ipcountry":"EG"` — so this is an observed signal, not an
-- assumed one. It is free on every Cloudflare plan, needs no third-party
-- geolocation provider, no API key, no per-lookup cost and no extra
-- latency.
--
-- WHY ONLY A COUNTRY. The brief asks for "October, Giza, Egypt" where
-- trustworthy information exists, and explicitly forbids guessing a city
-- from an IP. Atlas has no city-level source: `CF-IPCity` requires an
-- Enterprise plan, and commercial IP-to-city databases are guesses that
-- are routinely wrong by hundreds of kilometres for mobile carriers — the
-- exact fabrication the brief rules out. Country from Cloudflare is the
-- most precise thing that is actually TRUE, so it is what is stored.
-- Where even that is unavailable, the column stays NULL and the UI says
-- "Location unavailable" rather than inventing a place.
--
-- WHAT IS DELIBERATELY NOT STORED: no coordinates, no city, no
-- postal/ISP/ASN data, and no history — one current value per session
-- row, which is the minimum that makes "was this me?" answerable.
--
-- Two characters: an ISO 3166-1 alpha-2 code. Cloudflare's non-country
-- sentinels (`XX` unknown, `T1` Tor) are filtered in application code
-- before they ever reach this column.

ALTER TABLE "refresh_tokens"
  ADD COLUMN "location_country" VARCHAR(2);

-- Nullable with no default, so no existing row is rewritten and sessions
-- created before this shipped stay honestly unknown rather than being
-- backfilled with a guess.
