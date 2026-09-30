/**
 * BullMQ's Redis connection, built from `REDIS_URL` (plan §U.H, OPS-1).
 *
 * ioredis's `RedisOptions` has no `url` field (see `app.module.ts`), so the
 * URL is parsed into fields. Earlier only host, port and password were
 * kept, which silently dropped three things a managed Redis needs:
 *   - the database index (`redis://host:6379/2` connected to db 0),
 *   - TLS (`rediss://` connected in plaintext and failed the handshake),
 *   - an ACL username (`redis://user:pass@host`).
 * The password is also percent-decoded, as ioredis itself does for the
 * same URL in `RedisService`: `URL` keeps it encoded, so a password
 * containing `@`, `:` or `/` was sent to Redis still escaped.
 */
import type { ConnectionOptions } from 'bullmq';

/** Percent-decodes a URL credential; a malformed escape is kept as written. */
function decodeCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function bullConnectionFromRedisUrl(url: string): ConnectionOptions {
  const parsed = new URL(url);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL must use redis:// or rediss:// (got ${parsed.protocol})`);
  }
  const dbText = parsed.pathname.replace(/^\//, '');
  const db = dbText === '' ? 0 : Number(dbText);
  if (!Number.isInteger(db) || db < 0) {
    throw new Error(`REDIS_URL has an invalid database index "${dbText}"`);
  }
  const username = parsed.username ? decodeCredential(parsed.username) : undefined;
  const password = parsed.password ? decodeCredential(parsed.password) : undefined;
  return {
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port: Number(parsed.port || 6379),
    ...(username ? { username } : {}),
    password,
    db,
    ...(parsed.protocol === 'rediss:' ? { tls: { servername: parsed.hostname } } : {}),
    // BullMQ requires this on its connection.
    maxRetriesPerRequest: null,
  };
}
