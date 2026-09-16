/**
 * HttpsProbeService (P63) — Atlas's own answer to "is HTTPS actually
 * working on this hostname?".
 *
 * A provider status says what the provider believes; this is what a
 * visitor experiences. One bounded outbound `GET https://{hostname}/`:
 * a completed TLS handshake against a certificate Node trusts plus any
 * HTTP response means reachable. A handshake failure, DNS failure,
 * connection refusal or timeout means not reachable. Nothing is
 * inferred, and no response body is read.
 *
 * SSRF DISCIPLINE. The hostname is customer-controlled DNS, so:
 *   1. it is resolved FIRST (`dns.lookup`, all addresses), and if any
 *      resolved address is not public unicast (loopback, RFC 1918,
 *      link-local/metadata, CGNAT, ULA, multicast, reserved, v4-mapped
 *      private…) the probe is refused — recorded as unreachable, never
 *      attempted;
 *   2. the request is issued with Node's `https.request` and a `lookup`
 *      that returns ONLY the vetted address, so the connection cannot
 *      resolve a second time (no rebinding between check and connect);
 *   3. redirects are never followed (there is no client to follow them),
 *      the port is always 443, the scheme is always https, and the
 *      response body is discarded unread.
 * Node's `fetch` offers no address pinning, which is why it is not used.
 */
import { Injectable, Logger } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isPublicAddress, isIpLiteralHostname } from '../utils/outbound-address.util';

const PROBE_TIMEOUT_MS = 6_000;

export interface HttpsProbeResult {
  readonly reachable: boolean;
  readonly checkedAt: Date;
  /** Why the probe was refused before any connection, when it was. */
  readonly refused?: 'ip_literal' | 'non_public_address' | 'unresolvable';
}

@Injectable()
export class HttpsProbeService {
  private readonly logger = new Logger(HttpsProbeService.name);

  /** Resolves and vets; returns the one address to connect to, or a refusal reason. */
  async resolveVettedAddress(
    hostname: string,
  ): Promise<
    | { address: string; family: 4 | 6 }
    | { refused: NonNullable<HttpsProbeResult['refused']> }
  > {
    if (isIpLiteralHostname(hostname)) return { refused: 'ip_literal' };
    let addresses: { address: string; family: number }[];
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      return { refused: 'unresolvable' };
    }
    if (addresses.length === 0) return { refused: 'unresolvable' };
    if (addresses.some((entry) => !isPublicAddress(entry.address))) {
      return { refused: 'non_public_address' };
    }
    const chosen = addresses.find((entry) => entry.family === 4) ?? addresses[0];
    return { address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
  }

  async probe(hostname: string): Promise<HttpsProbeResult> {
    const checkedAt = new Date();
    const vetted = await this.resolveVettedAddress(hostname);
    if ('refused' in vetted) {
      this.logger.warn({ hostname, refused: vetted.refused }, 'HTTPS probe refused');
      return { reachable: false, checkedAt, refused: vetted.refused };
    }

    const reachable = await new Promise<boolean>((resolve) => {
      const req = httpsRequest(
        {
          host: hostname,
          servername: hostname,
          port: 443,
          method: 'GET',
          path: '/',
          headers: { 'user-agent': 'atlas-domain-probe/1', connection: 'close' },
          timeout: PROBE_TIMEOUT_MS,
          // Pin the connection to the vetted address: no second resolution.
          // Node's socket layer may call lookup with `all: true` (Happy
          // Eyeballs) and then expects an array; honour both shapes.
          lookup: ((
            _host: string,
            options: { all?: boolean },
            callback: (...args: unknown[]) => void,
          ) =>
            options?.all
              ? callback(null, [{ address: vetted.address, family: vetted.family }])
              : callback(null, vetted.address, vetted.family)) as never,
        },
        (res) => {
          res.resume(); // discard the body unread
          resolve(true);
          req.destroy();
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error('timeout'));
      });
      req.on('error', (error) => {
        this.logger.debug({ hostname, error: error.message }, 'HTTPS probe failed');
        resolve(false);
      });
      req.end();
    });

    return { reachable, checkedAt };
  }
}
