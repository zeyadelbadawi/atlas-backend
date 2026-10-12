/**
 * B0-MSG-06 — the committed catalogue reference must match the code.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMUNICATION_CATALOG } from './communication-catalog';
import {
  CATALOG_REFERENCE_PATH,
  notLaunchedReason,
  renderCatalogReference,
} from './catalog-reference';

describe('notification catalogue reference (B0-MSG-06)', () => {
  it('is up to date — run `npm run docs:communication-catalog` if this fails', () => {
    const committed = readFileSync(
      resolve(__dirname, '../../..', CATALOG_REFERENCE_PATH),
      'utf8',
    );
    expect(committed).toBe(renderCatalogReference());
  });

  it('lists every catalogue key exactly once', () => {
    const text = renderCatalogReference();
    for (const key of Object.keys(COMMUNICATION_CATALOG)) {
      expect(text.split(`| \`${key}\` |`)).toHaveLength(2);
    }
  });

  it('marks unlaunched features and only those', () => {
    expect(notLaunchedReason('live_session.scheduled')).toMatch(/Live Sessions/);
    expect(notLaunchedReason('live_provider.deauthorized')).toMatch(/Live Sessions/);
    expect(notLaunchedReason('retention.video.warning_7d')).toMatch(/hosted video/);
    expect(notLaunchedReason('course.order.paid')).toMatch(/Atlas Payments/);
    expect(notLaunchedReason('course.payment.approved')).toBeNull();
    expect(notLaunchedReason('auth.password.reset')).toBeNull();
  });
});
