-- Phone numbers: one account per number, and who else may read a number.
--
-- 1. UNIQUE. Owner decision (supersedes "NOT UNIQUE" in
--    20261110000200_user_phone): a number belongs to one account, whatever
--    its role. The unique index is the only arbiter — it holds under every
--    race and for every writer, and it is enforced even though RLS hides the
--    other account's row from the writer (an index constraint does not
--    consult row policies). The application pre-checks through
--    `user_phone_taken()` only to answer with a friendly message; the answer
--    is a bare boolean (never who owns the number), and both callers are
--    rate limited (registration per IP, a profile change per account).
--
--    Existing duplicates are not resolved silently: the guard below aborts
--    the migration, naming only how many numbers are shared, so a person
--    decides which account keeps each number. `deploy.sh` runs migrations
--    before replacing any container, so an abort leaves production as it was.
--
-- 2. WHO ELSE READS A NUMBER. Still never through the table: `user_phones`
--    keeps its self-only FORCE RLS for every command. Two narrow SECURITY
--    DEFINER readers return numbers for a batch of user ids, each deciding
--    from `app.current_user_id` (never from a parameter):
--      - `academy_student_phones(academy, ids)` — the academy's owner,
--        administrator or manager (or the organization owner) reading
--        students OF THAT ACADEMY. Instructors are not admitted
--        (`can_manage_academy_students` excludes them).
--      - `platform_student_phones(ids)` — the Platform Owner reading any
--        account that is a student of at least one academy.
--    Anyone else, or any id outside that scope, gets no row.

DO $$
DECLARE
  shared integer;
BEGIN
  SELECT count(*) INTO shared FROM (
    SELECT "phone_e164" FROM "user_phones" GROUP BY "phone_e164" HAVING count(*) > 1
  ) d;
  IF shared > 0 THEN
    RAISE EXCEPTION 'user_phones: % phone number(s) are shared by more than one account; resolve them before making phone numbers unique', shared;
  END IF;
END
$$;

CREATE UNIQUE INDEX "user_phones_phone_e164_key" ON "user_phones"("phone_e164");

CREATE FUNCTION user_phone_taken(p_phone_e164 text, p_exclude_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "user_phones"
    WHERE "phone_e164" = p_phone_e164
      AND (p_exclude_user_id IS NULL OR "user_id" <> p_exclude_user_id)
  );
$$;

CREATE FUNCTION academy_student_phones(p_academy_id text, p_user_ids text[])
RETURNS TABLE (user_id text, phone_e164 text, country_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p."user_id", p."phone_e164"::text, p."country_code"::text
  FROM "user_phones" p
  WHERE p."user_id" = ANY (p_user_ids)
    AND can_manage_academy_students(
      p_academy_id,
      NULLIF(current_setting('app.current_user_id', true), '')
    )
    AND EXISTS (
      SELECT 1 FROM "academy_students" s
      WHERE s."academy_id" = p_academy_id AND s."user_id" = p."user_id"
    );
$$;

CREATE FUNCTION platform_student_phones(p_user_ids text[])
RETURNS TABLE (user_id text, phone_e164 text, country_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p."user_id", p."phone_e164"::text, p."country_code"::text
  FROM "user_phones" p
  WHERE p."user_id" = ANY (p_user_ids)
    AND is_platform_owner(NULLIF(current_setting('app.current_user_id', true), ''))
    AND EXISTS (SELECT 1 FROM "academy_students" s WHERE s."user_id" = p."user_id");
$$;

REVOKE ALL ON FUNCTION user_phone_taken(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION academy_student_phones(text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_student_phones(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_phone_taken(text, text) TO "atlas_app";
GRANT EXECUTE ON FUNCTION academy_student_phones(text, text[]) TO "atlas_app";
GRANT EXECUTE ON FUNCTION platform_student_phones(text[]) TO "atlas_app";
