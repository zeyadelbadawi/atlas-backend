/**
 * B4 (UX audit) — limits for an academy's public contact phone and postal
 * address. Before these, "abc-phone" or a 600-character street saved and
 * showed on the academy's public pages. The dashboard checks the same
 * rules first and says what is wrong; these are the server's guard.
 */

/** Western or Arabic-Indic digits. */
const DIGIT = '[0-9\\u0660-\\u0669]';

/**
 * 7–30 characters of digits and `+ ( ) . / -` or spaces, with at least 7
 * digits — "+20 2 1234 5678", "(02) 1234-5678". Letters are refused.
 */
export const ACADEMY_CONTACT_PHONE_REGEX = new RegExp(
  `^(?=(?:[^0-9\\u0660-\\u0669]*${DIGIT}){7})[+0-9\\u0660-\\u0669 ()./-]{7,30}$`,
);

/** Empty (cleared), or 2–20 letters, digits, spaces and hyphens. */
export const ACADEMY_POSTAL_CODE_REGEX = /^(?:[\p{L}\p{Nd} -]{2,20})?$/u;

export const MAX_ACADEMY_ADDRESS_LINE_LENGTH = 200;
export const MAX_ACADEMY_ADDRESS_PART_LENGTH = 100;
