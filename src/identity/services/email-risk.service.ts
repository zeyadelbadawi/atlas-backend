/**
 * EmailRiskService — decides whether an address may create an Atlas
 * account at all.
 *
 * WHY THIS EXISTS. Free-Trial eligibility is keyed on the canonical email
 * (see `TrialEligibilityService`). That bar is only meaningful if minting
 * a fresh mailbox actually costs something: without this check, an abuser
 * points at a throwaway inbox provider and generates unlimited "new"
 * subjects for free, and the trial protection collapses. The three
 * layers — disposable blocking, deliverability, and verification — are
 * one mechanism, and weakening any of them weakens all of them.
 *
 * TWO INDEPENDENT SIGNALS, WITH DELIBERATELY DIFFERENT FAILURE MODES:
 *
 *   1. DISPOSABLE DOMAIN LIST — a local, community-maintained dataset of
 *      ~121k known throwaway providers, refreshed by updating the
 *      dependency rather than by hand-editing a list in this repository.
 *      It is in-process and cannot fail, so it FAILS CLOSED: a listed
 *      domain is always rejected.
 *
 *   2. DELIVERABILITY (DNS) — the domain must actually publish a way to
 *      receive mail. This catches typo domains and invented domains that
 *      no list could ever enumerate. It depends on the network, so it
 *      FAILS OPEN: if DNS is slow, rate-limited, or down, a legitimate
 *      signup must not be refused because OUR infrastructure blinked.
 *      An abuser cannot exploit that, because a domain with no MX cannot
 *      receive the verification email either — the verification step is
 *      what ultimately closes the loop.
 *
 * WHAT THIS DOES NOT DO. It does not attempt SMTP callback verification
 * (connecting to the target mail server to probe whether a mailbox
 * exists). That technique is widely treated as abusive, gets the sending
 * IP blocklisted, and is unreliable against catch-all domains. Sending a
 * real verification email is both more accurate and more honest.
 *
 * IT DOES NOT PENALISE CUSTOM DOMAINS. A business, school or personal
 * domain with valid MX records passes exactly like Gmail does. Nothing
 * here treats "not a well-known consumer provider" as suspicious.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveMx, resolve4, resolve6 } from 'node:dns/promises';
import disposableDomains from 'disposable-email-domains';
import { RedisService } from '../../redis/redis.service';
import { emailDomain } from '../../plans/utils/trial-subject.util';
import type { IdentityConfig } from '../../config/configuration';

/** Loaded once at module load — a Set lookup, not a linear scan of 121k entries per signup. */
const DISPOSABLE_DOMAINS = new Set<string>(disposableDomains as string[]);

const MX_CACHE_PREFIX = 'email:mx:';
/** Long enough that a signup burst costs one lookup; short enough that a newly-configured domain starts working the same day. */
const MX_CACHE_TTL_SECONDS = 6 * 60 * 60;
/** DNS must never be able to hang a signup request. */
const DNS_TIMEOUT_MS = 3000;

export type EmailRejectionReason = 'disposable' | 'undeliverable';

export interface EmailRiskVerdict {
  readonly acceptable: boolean;
  readonly reason?: EmailRejectionReason;
}

@Injectable()
export class EmailRiskService {
  private readonly logger = new Logger(EmailRiskService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Whether this address may be used to create an account.
   *
   * Callers must map a rejection to a single generic user-facing message.
   * Reporting WHICH check failed would tell an abuser exactly how to
   * adapt — whether to find a domain missing from the list, or one with
   * MX records configured.
   */
  async evaluate(email: string): Promise<EmailRiskVerdict> {
    const domain = emailDomain(email);
    if (!domain) return { acceptable: false, reason: 'undeliverable' };

    // Cheap, local, deterministic, and authoritative — always first, and
    // never disabled by configuration in any environment.
    if (DISPOSABLE_DOMAINS.has(domain)) {
      return { acceptable: false, reason: 'disposable' };
    }

    // The DNS half is skippable, and is skipped in `test`. The suite
    // registers accounts at `@atlas.test` — a reserved TLD that by
    // definition has no DNS — so leaving this on would fail every
    // existing e2e suite, and would additionally make the whole test
    // run depend on live DNS resolution.
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    if (!identity.emailDeliverabilityCheckEnabled) return { acceptable: true };

    const deliverable = await this.hasMailExchanger(domain);
    if (!deliverable) return { acceptable: false, reason: 'undeliverable' };

    return { acceptable: true };
  }

  /**
   * Whether the domain publishes any way to receive mail.
   *
   * Accepts an A/AAAA record as well as MX: RFC 5321 §5.1 makes the
   * address record an implicit mail destination when no MX exists, and
   * some small legitimate domains genuinely rely on that. Rejecting them
   * would be a false positive against exactly the "custom business
   * domain" case that must keep working.
   */
  private async hasMailExchanger(domain: string): Promise<boolean> {
    const cacheKey = `${MX_CACHE_PREFIX}${domain}`;

    try {
      const cached = await this.redisService.getClient().get(cacheKey);
      if (cached === '1') return true;
      if (cached === '0') return false;
    } catch {
      // Cache unavailable — fall through to a live lookup rather than
      // failing the signup.
    }

    let deliverable: boolean;
    try {
      deliverable = await this.lookupWithTimeout(domain);
    } catch (error) {
      // FAIL OPEN. A DNS outage on our side must not block real
      // customers. The verification email is the backstop: an address
      // that cannot receive mail still cannot complete verification, and
      // an unverified account cannot claim a trial.
      this.logger.warn(
        { domain, error: error instanceof Error ? error.message : error },
        'Mail-exchanger lookup failed; accepting the address and relying on email verification.',
      );
      return true;
    }

    try {
      await this.redisService
        .getClient()
        .set(cacheKey, deliverable ? '1' : '0', 'EX', MX_CACHE_TTL_SECONDS);
    } catch {
      // Caching is an optimisation, never a correctness requirement.
    }

    return deliverable;
  }

  private async lookupWithTimeout(domain: string): Promise<boolean> {
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('DNS lookup timed out')), DNS_TIMEOUT_MS).unref();
    });

    return Promise.race([this.lookupMailDestination(domain), timeout]);
  }

  private async lookupMailDestination(domain: string): Promise<boolean> {
    try {
      const records = await resolveMx(domain);
      // A single "." MX is the RFC 7505 "null MX" — an explicit
      // declaration that the domain accepts no mail at all.
      const usable = records.filter((r) => r.exchange && r.exchange !== '.');
      if (usable.length > 0) return true;
      // An explicit null MX is a definitive "no", not a reason to fall
      // back to A records.
      if (records.length > 0) return false;
    } catch {
      // NXDOMAIN / no MX records — fall through to the A/AAAA fallback.
    }

    try {
      const a = await resolve4(domain);
      if (a.length > 0) return true;
    } catch {
      /* fall through */
    }

    try {
      const aaaa = await resolve6(domain);
      return aaaa.length > 0;
    } catch {
      return false;
    }
  }
}
