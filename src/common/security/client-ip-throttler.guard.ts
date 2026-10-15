/**
 * P63g — the global throttler keyed on the REAL client address.
 *
 * `@nestjs/throttler` keys on `request.ip`, which behind Cloudflare and
 * Caddy resolved to Cloudflare's edge address: every visitor of every
 * academy behind one datacentre shared one bucket, so a single busy site
 * could 429 unrelated customers' visitors and sign-ins. `resolveClientIp`
 * applies the production trust model (Caddy's `X-Real-IP` when the peer
 * is the proxy, the socket peer otherwise).
 */
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { resolveClientIp } from '../../identity/utils/request-metadata.util';
import { ipThrottleKey } from './ip-throttle-key.util';

@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Request): Promise<string> {
    return resolveClientIp(req) ?? req.ip ?? 'unknown';
  }
}

/**
 * Per-route tracker for the anonymous abuse-prone forms (the platform and
 * academy contact forms): the same real client address, but an IPv6
 * client is keyed on its /64 so rotating addresses inside one subscriber
 * prefix cannot escape the limit (`ipThrottleKey`). IPv4 keys are
 * unchanged. Used as `@Throttle({ default: { ..., getTracker } })`.
 */
export function clientIpPrefixTracker(req: Record<string, unknown>): string {
  const request = req as unknown as Request;
  return ipThrottleKey(resolveClientIp(request) ?? request.ip ?? 'unknown');
}
