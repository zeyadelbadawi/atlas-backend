/**
 * Production-readiness pass — every authentication refusal is counted once,
 * centrally, by the global exception filter, under a BOUNDED label set.
 */
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { METRICS_REGISTRY } from './learning-metrics.service';
import { recordAuthRefusal } from './auth-security-metrics';

async function refusals(): Promise<Record<string, number>> {
  const metric = METRICS_REGISTRY.getSingleMetric('atlas_auth_refusals_total');
  const data = await metric!.get();
  return Object.fromEntries(data.values.map((v) => [String(v.labels.key), v.value]));
}

function hostFor(): ArgumentsHost {
  const response = { status: () => response, json: () => response };
  return {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ requestId: 'r1' }),
    }),
  } as unknown as ArgumentsHost;
}

describe('atlas_auth_refusals_total', () => {
  const filter = new AllExceptionsFilter({ warn: jest.fn(), error: jest.fn() } as never);

  it('the exception filter counts an errors.auth.* refusal by its key', async () => {
    const before = (await refusals()).invalidCredentials ?? 0;
    filter.catch(
      new UnauthorizedException({ messageKey: 'errors.auth.invalidCredentials' }),
      hostFor(),
    );
    expect((await refusals()).invalidCredentials).toBe(before + 1);
  });

  it('ignores refusals that are not authentication refusals', async () => {
    const before = await refusals();
    filter.catch(
      new BadRequestException({ messageKey: 'errors.validation.failed' }),
      hostFor(),
    );
    expect(await refusals()).toEqual(before);
  });

  it('folds anything not shaped like a code key into `other` (bounded cardinality)', async () => {
    const before = (await refusals()).other ?? 0;
    recordAuthRefusal('errors.auth.' + 'x'.repeat(200));
    recordAuthRefusal('errors.auth.has spaces/and?query=1');
    const after = await refusals();
    expect(after.other).toBe(before + 2);
    expect(Object.keys(after).every((k) => /^[A-Za-z]{1,48}$/.test(k))).toBe(true);
  });
});
