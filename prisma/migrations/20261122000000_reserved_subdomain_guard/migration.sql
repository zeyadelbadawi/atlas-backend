-- DL-57 — platform subdomain labels (`docs`, `help`, `api`, …) and their
-- look-alikes can never be held by an academy, enforced in the database as
-- well as in the API (`isReservedSubdomain` in
-- `src/provisioning/dto/provisioning.constants.ts`; the specs compare the
-- two). The help center moves to `docs.<base>`, a host the wildcard routes
-- to academies, so a label an academy could claim must be refused even on
-- a code path that skips the service check.
--
-- Only NEW labels are refused: the triggers ignore an UPDATE that keeps the
-- label (the settings forms re-send it on every save), so a row created
-- before a word was reserved keeps working. Release verify reports any
-- such row. No data is read or written.

CREATE OR REPLACE FUNCTION atlas_is_reserved_subdomain(label text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  WITH forms AS (
    SELECT v,
           replace(v, '-', '') AS j,
           translate(replace(v, '-', ''), '013457', 'oleast') AS s1,
           translate(replace(v, '-', ''), '013457', 'oieast') AS s2
      FROM (SELECT lower(btrim(label)) AS v) l
  ), lists AS (
    SELECT ARRAY[
      'www', 'app', 'api', 'admin', 'dashboard', 'platform', 'atlas',
      'mail', 'status', 'support', 'docs', 'doc', 'help', 'blog',
      'learn', 'kb', 'faq', 'wiki', 'video', 'ssh', 'cdn', 'static',
      'assets', 'media', 'files', 'auth', 'login', 'signin', 'signup',
      'register', 'account', 'accounts', 'billing', 'pay', 'payment',
      'payments', 'checkout', 'sso', 'oauth', 'id', 'identity',
      'secure', 'security', 'verify', 'email', 'webmail', 'smtp',
      'imap', 'pop', 'mx', 'ns1', 'ns2', 'ftp', 'dev', 'staging',
      'test', 'preview', 'sandbox', 'beta', 'demo', 'internal',
      'system', 'root', 'origin', 'metrics', 'health', 'owner',
      'manage', 'management', 'academy', 'org', 'organization'
    ]::text[] AS reserved,
    '^(official|services|central|service|center|centre|online|portal|cloud|pages|panel|desk|home|info|main|page|site|team|get|hub|net|the|web|go|my|[0-9]+)*(dashboard|accounts|checkout|identity|internal|payments|platform|register|security|account|billing|payment|preview|sandbox|staging|support|webmail|assets|origin|secure|signin|signup|static|status|system|verify|admin|email|files|login|media|oauth|video|auth|blog|docs|help|mail|root|wiki|api|app|cdn|doc|faq|pay|ssh|sso|www|kb)(dashboard|accounts|checkout|identity|internal|payments|platform|register|security|account|billing|payment|preview|sandbox|staging|support|webmail|assets|origin|secure|signin|signup|static|status|system|verify|admin|email|files|login|media|oauth|video|auth|blog|docs|help|mail|root|wiki|api|app|cdn|doc|faq|pay|ssh|sso|www|kb|official|services|central|service|center|centre|online|portal|cloud|pages|panel|desk|home|info|main|page|site|team|get|hub|net|the|web|go|my|[0-9]+)*$'::text AS lookalike
  )
  SELECT v = ANY (reserved)
      OR j = ANY (reserved) OR s1 = ANY (reserved) OR s2 = ANY (reserved)
      OR strpos(j, 'atlas') > 0 OR strpos(s1, 'atlas') > 0 OR strpos(s2, 'atlas') > 0
      OR left(j, 5) = 'admin' OR left(s1, 5) = 'admin' OR left(s2, 5) = 'admin'
      OR j ~ lookalike OR s1 ~ lookalike
    FROM forms, lists
$fn$;

CREATE OR REPLACE FUNCTION atlas_refuse_reserved_subdomain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  new_label text := to_jsonb(NEW) ->> TG_ARGV[0];
BEGIN
  IF TG_OP = 'UPDATE' AND new_label IS NOT DISTINCT FROM (to_jsonb(OLD) ->> TG_ARGV[0]) THEN
    RETURN NEW;
  END IF;
  IF public.atlas_is_reserved_subdomain(new_label) THEN
    RAISE EXCEPTION 'subdomain label "%" is reserved for Atlas', new_label
      USING ERRCODE = 'check_violation', CONSTRAINT = 'atlas_reserved_subdomain';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS academies_reserved_slug ON academies;
CREATE TRIGGER academies_reserved_slug
  BEFORE INSERT OR UPDATE OF slug ON academies
  FOR EACH ROW EXECUTE FUNCTION atlas_refuse_reserved_subdomain('slug');

DROP TRIGGER IF EXISTS subdomain_allocations_reserved_label ON subdomain_allocations;
CREATE TRIGGER subdomain_allocations_reserved_label
  BEFORE INSERT OR UPDATE OF subdomain ON subdomain_allocations
  FOR EACH ROW EXECUTE FUNCTION atlas_refuse_reserved_subdomain('subdomain');
