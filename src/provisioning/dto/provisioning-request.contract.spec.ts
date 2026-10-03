import type { ProvisioningRequest, ProvisioningStep } from '@prisma/client';
import { toProvisioningRequestResponse } from './provisioning-request.contract';

function request(overrides: Partial<ProvisioningRequest> = {}): ProvisioningRequest {
  return {
    id: 'req-1',
    organizationId: 'org-1',
    academyId: null,
    requestedByUserId: 'u1',
    status: 'academy_created',
    currentStepKey: 'theme',
    requestedAcademyName: 'Nile',
    requestedSubdomain: 'nile',
    triggeringPaymentId: null,
    selectedThemeKey: 'modern-education',
    websiteSetupMode: 'complete',
    requestedBrand: null,
    lastProgressAt: new Date('2026-10-01T10:00:00Z'),
    idempotencyKey: 'k',
    attemptCount: 1,
    lastError: null,
    startedAt: new Date('2026-10-01T09:59:59Z'),
    completedAt: null,
    failedAt: null,
    autoSupportCaseId: null,
    createdAt: new Date('2026-10-01T09:59:58Z'),
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  };
}

const steps: ProvisioningStep[] = [];

describe('provisioning request contract (W2 — stage, stalled)', () => {
  it('reports the real stage of the current step', () => {
    const at = (currentStepKey: ProvisioningRequest['currentStepKey']) =>
      toProvisioningRequestResponse(request({ currentStepKey }), steps, null, null).stage;
    expect(at('tenant')).toBe('academy');
    expect(at('academy')).toBe('academy');
    expect(at('theme')).toBe('website');
    expect(at('branding')).toBe('brand');
    expect(at('subdomain')).toBe('finalize');
    expect(at('finalization')).toBe('finalize');
    expect(
      toProvisioningRequestResponse(
        request({ status: 'ready', currentStepKey: 'finalization' }),
        steps,
        null,
        null,
      ).stage,
    ).toBe('ready');
  });

  it('is stalled only when non-terminal and silent for longer than the threshold', () => {
    const base = new Date('2026-10-01T10:00:00Z').getTime();
    const check = (secondsLater: number, status: ProvisioningRequest['status']) =>
      toProvisioningRequestResponse(request({ status }), steps, null, null, {
        now: new Date(base + secondsLater * 1000),
        stallThresholdSeconds: 30,
      }).stalled;
    expect(check(10, 'academy_created')).toBe(false);
    expect(check(31, 'academy_created')).toBe(true);
    expect(check(3600, 'ready')).toBe(false);
    expect(check(3600, 'failed')).toBe(false);
    expect(check(3600, 'cancelled')).toBe(false);
  });

  it('falls back to startedAt/createdAt for rows from before lastProgressAt existed', () => {
    const response = toProvisioningRequestResponse(
      request({ lastProgressAt: null }),
      steps,
      null,
      null,
    );
    expect(response.lastProgressAt).toBe('2026-10-01T09:59:59.000Z');
    expect(
      toProvisioningRequestResponse(
        request({ lastProgressAt: null, startedAt: null }),
        steps,
        null,
        null,
      ).lastProgressAt,
    ).toBe('2026-10-01T09:59:58.000Z');
  });

  it('summarizes the requested brand without exposing the palette', () => {
    const response = toProvisioningRequestResponse(
      request({
        requestedBrand: {
          palette: {
            seeds: { primary: '221 83% 53%' },
            status: 'confirmed',
            source: 'manual',
          },
          logo: { status: 'awaiting_upload' },
        },
      }),
      steps,
      null,
      null,
    );
    expect(response.requestedBrand).toEqual({ palette: true, logo: 'awaiting_upload' });
    expect(JSON.stringify(response)).not.toContain('221 83% 53%');
  });
});
