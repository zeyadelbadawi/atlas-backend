/**
 * Minimal `Cookie:` header reader.
 *
 * Deliberately not `cookie-parser`. Atlas reads exactly ONE cookie
 * (`atlas_device`) and writes exactly one, so adding request-wide cookie
 * middleware would put a parsed `req.cookies` on every route in the
 * application to serve a single feature — a wider change than the feature
 * needs, and one that quietly invites other code to start trusting cookies
 * that were never meant to be credentials.
 *
 * Values are decoded but otherwise returned verbatim: the caller decides
 * what a value means, and the only caller matches it against a stored hash
 * that an arbitrary string simply fails.
 */
export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/**
 * The attributes every Atlas-issued cookie carries.
 *
 * `httpOnly` so script on the page cannot read the device identity;
 * `sameSite: 'lax'` because the academy surface is same-site and a
 * cross-site POST must not carry it; `secure` everywhere but local HTTP,
 * where a secure cookie would simply never be stored and the feature would
 * silently not work for developers.
 */
export function deviceCookieOptions(args: {
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: args.secure,
    path: '/',
    maxAge: args.maxAgeSeconds * 1000,
  };
}
