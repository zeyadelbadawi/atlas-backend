/**
 * The two decisions `EmailOtpService` makes BEFORE it touches Postgres
 * (P64 C4): which policy applies to a surface, and whether this sign-in
 * must therefore stop for a code.
 *
 * Worth pinning in isolation because both are easy to get subtly wrong in
 * the direction that removes a control without failing anything: reading
 * the academy policy on the management surface, or treating "the trust
 * lookup threw" as "this device is trusted".
 *
 * The full challenge lifecycle — issue, wrong code, expiry, lockout,
 * single use, resend, cross-user — is exercised end to end against real
 * Postgres and real RLS in `test/p64-c4-email-otp.e2e-spec.ts`, because
 * every one of those properties is enforced by a SQL statement and a
 * mocked transaction would prove nothing about it.
 */
import { ConfigService } from '@nestjs/config';
import { EmailOtpService, maskEmail } from './email-otp.service';
import type { TrustedDeviceService } from './trusted-device.service';
import type { EmailOtpPolicy } from '../../config/configuration';

function build(policies: { management: EmailOtpPolicy; academy: EmailOtpPolicy }) {
  const isTrusted = jest.fn<Promise<boolean>, [unknown]>();
  const trustedDeviceService = { isTrusted } as unknown as TrustedDeviceService;
  const configService = {
    getOrThrow: () => ({
      emailOtp: {
        ...policies,
        codeTtlSeconds: 600,
        maxAttempts: 5,
        maxCodesPerChallenge: 3,
        resendCooldownSeconds: 60,
        challengesPerHour: 5,
        trustedDeviceDaysManagement: 90,
        trustedDeviceDaysAcademy: 180,
        privilegedFloor: 'new_device',
      },
    }),
  } as unknown as ConfigService;

  const service = new EmailOtpService(
    configService,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    trustedDeviceService,
  );
  return { service, isTrusted };
}

describe('EmailOtpService policy', () => {
  it('reads the policy of the surface being signed into, not the other one', () => {
    const { service } = build({ management: 'always', academy: 'off' });
    expect(service.policyFor('management')).toBe('always');
    expect(service.policyFor('academy')).toBe('off');
  });

  it('demands nothing when the surface is `off`', async () => {
    const { service, isTrusted } = build({ management: 'off', academy: 'off' });
    await expect(
      service.isRequired({ userId: 'u1', surface: 'management' }),
    ).resolves.toBe(false);
    // Not even consulted: `off` is the pre-C4 behaviour, byte for byte.
    expect(isTrusted).not.toHaveBeenCalled();
  });

  it('demands a code on every sign-in when the surface is `always`', async () => {
    const { service, isTrusted } = build({ management: 'always', academy: 'always' });
    await expect(
      service.isRequired({ userId: 'u1', surface: 'management', trustCookie: 'x' }),
    ).resolves.toBe(true);
    // A trusted browser must NOT be able to skip an `always` policy —
    // that is the entire difference between the two modes.
    expect(isTrusted).not.toHaveBeenCalled();
  });

  it('under `new_device`, skips the code only for a browser that is actually trusted', async () => {
    const { service, isTrusted } = build({
      management: 'new_device',
      academy: 'new_device',
    });

    isTrusted.mockResolvedValueOnce(true);
    await expect(
      service.isRequired({ userId: 'u1', surface: 'management', trustCookie: 'c' }),
    ).resolves.toBe(false);

    isTrusted.mockResolvedValueOnce(false);
    await expect(
      service.isRequired({ userId: 'u1', surface: 'management', trustCookie: 'c' }),
    ).resolves.toBe(true);
  });

  it('passes the surface through to the trust lookup, so trust is per surface', async () => {
    const { service, isTrusted } = build({
      management: 'new_device',
      academy: 'new_device',
    });
    isTrusted.mockResolvedValue(false);
    await service.isRequired({ userId: 'u1', surface: 'academy', trustCookie: 'c' });
    // The device service's own parameter name — a mismatch here is
    // invisible in TypeScript's structural world and silently makes every
    // browser look untrusted.
    expect(isTrusted).toHaveBeenCalledWith({
      userId: 'u1',
      surface: 'academy',
      cookieValue: 'c',
    });
  });
});

describe('maskEmail', () => {
  it('shows one character of the local part and the full domain', () => {
    expect(maskEmail('sami@example.com')).toBe('s•••@example.com');
  });

  it('never reveals the length of the local part', () => {
    // Two very different addresses at the same domain must look
    // identical apart from their first letter — otherwise the mask is a
    // hint about the address rather than a reminder of it.
    expect(maskEmail('ab@example.com')).toBe('a•••@example.com');
    expect(maskEmail('abcdefghijklmnop@example.com')).toBe('a•••@example.com');
  });

  it('handles a plus-addressed and a subdomain address', () => {
    expect(maskEmail('sami+atlas@mail.example.co.uk')).toBe('s•••@mail.example.co.uk');
  });

  it('reveals nothing at all for something that is not an address', () => {
    expect(maskEmail('not-an-address')).toBe('•••');
    expect(maskEmail('@example.com')).toBe('•••');
    expect(maskEmail('')).toBe('•••');
  });
});
