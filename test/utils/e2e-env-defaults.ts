/**
 * Environment defaults for the e2e suites, applied before any test file
 * loads the app.
 *
 * `AUTH_PRIVILEGED_EMAIL_OTP_FLOOR` — production defaults it to
 * `new_device` (ATO review F11): an organization owner or Platform Owner
 * signing in to the management surface on a new browser gets an emailed
 * code. Almost every suite signs in as an organization owner to reach the
 * feature it tests, so the suites run with the floor `off` unless they set
 * it themselves; `test/privileged-mfa.e2e-spec.ts` turns it on and covers
 * the control.
 */
process.env.AUTH_PRIVILEGED_EMAIL_OTP_FLOOR ??= 'off';

/**
 * `PLATFORM_OWNER_TOTP_REQUIRED_FROM` — production requires an authenticator
 * app for Platform Owners from a fixed date (ATO review F11). Suites that act
 * as the Platform Owner would otherwise start failing on that date for a
 * reason unrelated to what they test; `test/privileged-mfa.e2e-spec.ts`
 * covers the requirement with a date in the past.
 */
process.env.PLATFORM_OWNER_TOTP_REQUIRED_FROM ??= 'never';
